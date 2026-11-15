// AI-written glue (v1). Hook shapes copied from human Valenced plugins:
//  - send/edit `instead` hooks: valenced-community-plugins fake-nitro/src/patches/expressions/fakeify.ts:138-158
//  - module lookup: gif-to-chat-input/index.ts:27-35
//  - Flux payload rewrite: clear-urls/index.tsx:64-71, event shapes from klipy-gif-fix/js/index.ts:335-338
//  - jsonStorage wiring: anonymous-file-names/js/index.ts:41-47
// Behaviour mirrors cozmicat123/aliucord-e2ee@aegires-sync E2eePlugin.kt (Aegires MessageCryptoHelper).
import { onFluxEventDispatched, Stores } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withName, withProps } from '@valenced/modules/finders/filters'
import { callNativeMethod, callNativeMethodSync } from '@valenced/modules/native'
import { after, instead } from '@valenced/patcher'
import SettingsComponent from './settings'

export interface Settings {
        enabled: boolean
        preset: number // Crypto.Preset index: 0 = AES-128, 1 = AES-192, 2 = AES-256
}

export const ID = 'cozmicat123.e2ee'

declare module '@valenced/modules/native' {
        interface NativeMethods {
                'cozmicat123.e2ee.configure': [args: [enabled: boolean, preset: number], returnValue: null]
                'cozmicat123.e2ee.setKey': [args: [password: string], returnValue: boolean]
                'cozmicat123.e2ee.clearKey': [args: [], returnValue: null]
                'cozmicat123.e2ee.hasKey': [args: [], returnValue: boolean]
                'cozmicat123.e2ee.status': [args: [], returnValue: string]
                'cozmicat123.e2ee.encrypt': [
                        args: [channelId: string, plain: string, selfId: string | null],
                        returnValue: { text: string | null; error: string | null } | null,
                ]
                'cozmicat123.e2ee.decrypt': [
                        args: [items: [content: unknown, channelId: string, authorId: string | null][]],
                        returnValue: { text: string | null; enc: boolean }[],
                ]
        }
}

interface MessageActions {
        sendMessage(channelId: string, message: { content: string }, clearDraft: boolean, options?: object): unknown
        editMessage(channelId: string, messageId: string, message: { content: string }): unknown
}

// Flux message objects (snake_case, as sent by the gateway)
interface FluxMessage {
        id?: string
        content?: string
        channel_id?: string
        author?: { id?: string }
        referenced_message?: FluxMessage | null
}

// TEMP diagnostics (AI glue), removed before release
export const dbg = { hooks: '', send: 0, edit: 0, flux: 0, cache: '', last: '', rec: '' }

// Ids of messages that were sent encrypted (Aegires Message.encrypted). Capped so it cannot grow forever.
const encryptedIds = new Set<string>()
const MAX_IDS = 5000

// Replace encrypted content in place. The message and its reply preview go in one native call.
function decryptMessages(messages: FluxMessage[], fallbackChannel?: string) {
        const targets: FluxMessage[] = []
        const items: [unknown, string, string | null][] = []
        const isMain: boolean[] = []
        const add = (m: FluxMessage | null | undefined, channel: string | undefined, main: boolean) => {
                const channelId = m?.channel_id ?? channel
                if (!m || !channelId) return
                targets.push(m)
                items.push([m.content, channelId, m.author?.id ?? null])
                isMain.push(main)
        }
        for (const m of messages) {
                add(m, fallbackChannel, true)
                add(m.referenced_message, m.channel_id ?? fallbackChannel, false)
        }
        if (!items.length) return
        let out: { text: string | null; enc: boolean }[]
        try {
                out = callNativeMethodSync('cozmicat123.e2ee.decrypt', [items])
        } catch (e) {
                dbg.last = `decrypt: ${e}`
                return
        }
        out.forEach(({ text, enc }, i) => {
                if (text !== null) targets[i].content = text
                const id = targets[i].id
                if (enc && isMain[i] && id) {
                        encryptedIds.add(id)
                        if (encryptedIds.size > MAX_IDS) encryptedIds.delete(encryptedIds.values().next().value!)
                }
        })
}

// Aegires MessageBinder.java:46 puts a lock before the time; here it goes before the name (show-tag hooks the same row field)
const LOCK = '\uD83D\uDD12 '
const MessageRowType = 1

interface RowManager {
        prototype: { generate(args: { message?: any }): MessageRow }
}

interface MessageRow {
        type?: number
        message?: { id?: string; username?: string }
}

export default plugin<{ jsonStorage: Settings }>({
        jsonStorage: { load: true, default: { enabled: false, preset: 2 } },
        start({ cleanup, jsonStorage: storage, plugin }) {
                // The row hook needs the message list to be built after it is installed
                if (plugin.startedLate) {
                        plugin.requireReload()
                        return
                }

                // Fails closed: returns false when the message must not be sent
                dbg.hooks = `startedLate=${plugin.startedLate}`
                const encryptOutgoing = (channelId: string, data: { content?: string } | undefined) => {
                        const plain = data?.content?.trim()
                        dbg.cache = JSON.stringify(storage.cache)
                        if (!data || !plain) return true
                        callNativeMethodSync('cozmicat123.e2ee.configure', [
                                !!storage.cache?.enabled,
                                storage.cache?.preset ?? 2,
                        ])
                        const selfId = (Stores as any).UserStore?.getCurrentUser?.()?.id ?? null
                        const res = callNativeMethodSync('cozmicat123.e2ee.encrypt', [channelId, plain, selfId])
                        if (res === null) return true // encryption off for this channel
                        if (res.error || !res.text) {
                                plugin.reportError(res.error ?? 'Encryption failed')
                                return false
                        }
                        data.content = res.text
                        return true
                }

                cleanup(
                        getModules(withProps<MessageActions>('sendMessage', 'editMessage'), messages => {
                                cleanup(
                                        instead(messages, 'sendMessage', function (args, original) {
                                                dbg.send++
                                                if (!encryptOutgoing(args[0], args[1])) return
                                                return Reflect.apply(original, this, args)
                                        }),
                                        instead(messages, 'editMessage', function (args, original) {
                                                dbg.edit++
                                                if (!encryptOutgoing(args[0], args[2])) return
                                                return Reflect.apply(original, this, args)
                                        }),
                                )
                        }),
                )

                cleanup(
                        // modules/messages/native/renderer/RowGenerator.tsx, as in show-tag
                        getModules(withName<RowManager>('RowManager'), ({ prototype }) => {
                                cleanup(
                                        // Already-cached messages: decrypt when the list (re)builds a row. Same idea as the Aliucord
                                        // plugin's `before onConfigure { decrypt(it) }`; hook form from anonymous-file-names (`before`).
                                        before(prototype, 'generate', args => {
                                                const m = args[0]?.message
                                                try {
                                                        if (m && !dbg.rec)
                                                                dbg.rec = `content=${typeof m.content} ch=${m.channel_id}|${m.channelId} id=${typeof m.id} keys=${Object.keys(m).slice(0, 40).join(',')}`
                                                        if (m && typeof m.content === 'string') decryptMessages([m], m.channelId)
                                                } catch (e) {
                                                        dbg.last = `row: ${e}`
                                                }
                                                return args
                                        }),
                                        after(prototype, 'generate', row => {
                                                const m = row?.type === MessageRowType ? row.message : undefined
                                                if (!m?.id || m.username == null || !encryptedIds.has(m.id)) return row
                                                return { ...row, message: { ...m, username: LOCK + m.username } }
                                        }),
                                )
                        }),
                )

                cleanup(
                        onFluxEventDispatched('MESSAGE_CREATE', evt => {
                                dbg.flux++
                                if ((evt as any)?.message) decryptMessages([(evt as any).message])
                                return evt
                        }),
                        onFluxEventDispatched('MESSAGE_UPDATE', evt => {
                                if ((evt as any)?.message) decryptMessages([(evt as any).message])
                                return evt
                        }),
                        onFluxEventDispatched('LOAD_MESSAGES_SUCCESS', evt => {
                                const e = evt as any
                                dbg.flux++
                                if (Array.isArray(e?.messages)) decryptMessages(e.messages, e.channelId)
                                return evt
                        }),
                )
        },
        stop() {
                callNativeMethod('cozmicat123.e2ee.clearKey', [])
        },
        SettingsComponent,
})
