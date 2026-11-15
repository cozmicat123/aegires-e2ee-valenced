// AI-written glue (v1). Hook shapes copied from human Valenced plugins:
//  - send/edit `instead` hooks: valenced-community-plugins fake-nitro/src/patches/expressions/fakeify.ts:138-158
//  - module lookup: gif-to-chat-input/index.ts:27-35
//  - Flux payload rewrite: clear-urls/index.tsx:104-111 (MESSAGE_CREATE). The LOAD_MESSAGES_SUCCESS shape ({ messages, channelId })
//    has no human source; it is only verified by working on device
//  - jsonStorage wiring: anonymous-file-names/js/index.ts:39-44
//  - redecrypt after Set key: valid-user/js/index.ts:54-83 (redrawMentions)
// Behaviour mirrors cozmicat123/aliucord-e2ee@aegires-sync E2eePlugin.kt (Aegires MessageCryptoHelper).
import { ToastActionCreators } from '@valenced/discord/actions'
import { Dispatcher } from '@valenced/discord/common/flux'
import { onFluxEventDispatched, Stores } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withName, withProps } from '@valenced/modules/finders/filters'
import { callNativeMethod, callNativeMethodSync } from '@valenced/modules/native'
import { after, before, instead } from '@valenced/patcher'
import SettingsComponent from './settings'
import type { DiscordModules } from '@valenced/discord/types'

export interface Settings {
        enabled: boolean
        preset: number // Crypto.Preset index: 0 = AES-128, 1 = AES-192, 2 = AES-256
}

export const ID = 'cozmicat123.e2ee'

// Errors are shown as a toast, as in Aegires MessageCryptoHelper.java:42 and the Aliucord plugin's showToast.
// Call shape: valenced-plugins better-invites/js/index.tsx:32, bio-emoji-button/js/picker.tsx:262
const ToastKey = `${ID}.error`

declare module '@valenced/modules/native' {
        interface NativeMethods {
                'cozmicat123.e2ee.configure': [args: [enabled: boolean, preset: number], returnValue: null]
                'cozmicat123.e2ee.setKey': [args: [password: string], returnValue: boolean]
                'cozmicat123.e2ee.clearKey': [args: [], returnValue: null]
                'cozmicat123.e2ee.hasKey': [args: [], returnValue: boolean]
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

// Ids of messages that were sent encrypted (Aegires Message.encrypted). Capped so it cannot grow forever.
const encryptedIds = new Set<string>()
const MAX_IDS = 5000

// Same test as Crypto.looksEncrypted (Crypto.java: PREFIX line 65, looksEncrypted 83-85; pinned dddead0 "\u00A7"). Checked here so plain rows never cross the bridge.
const looksEncrypted = (s: unknown): s is string => typeof s === 'string' && s.startsWith('\u00A7')

// Replace encrypted content in place. The message and its reply preview go in one native call.
function decryptMessages(messages: FluxMessage[], fallbackChannel?: string) {
        const targets: FluxMessage[] = []
        const items: [unknown, string, string | null][] = []
        const isMain: boolean[] = []
        const add = (m: FluxMessage | null | undefined, channel: string | undefined, main: boolean) => {
                const channelId = m?.channel_id ?? channel
                if (!m || !channelId || !looksEncrypted(m.content)) return
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
                console.warn('[e2ee] decrypt failed', e)
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

// Rows keep what they were first built with, so a new key alone changes nothing (valid-user redrawMentions has the same
// problem). Decrypt the loaded messages of the open channel and send the result back as a MESSAGE_UPDATE.
export function redecrypt() {
        const SelectedChannelStore = Stores.SelectedChannelStore as DiscordModules.Flux.Store<{
                getChannelId(): string | undefined
        }>
        const channelId = SelectedChannelStore.getChannelId()
        if (!channelId) return

        const MessageStore = Stores.MessageStore as DiscordModules.Flux.Store<{
                getMessages(channelId: string): { toArray(): FluxMessage[] }
        }>
        for (const { id, content, author } of MessageStore.getMessages(channelId).toArray()) {
                if (!id || !looksEncrypted(content)) continue
                const copy: FluxMessage = { id, content, channel_id: channelId, author: { id: author?.id } }
                decryptMessages([copy])
                if (copy.content === content) continue
                Dispatcher.dispatch({
                        type: 'MESSAGE_UPDATE',
                        message: { id, channel_id: channelId, content: copy.content },
                })
        }
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
                // The key lives in native memory only, so after a restart there is none. Start with encryption off;
                // the settings page does not let it be turned on without a key.
                // cache may not be loaded yet here, so read through get() as fake-nitro fakeify.ts:40 does
                storage.get().then(
                        s => {
                                if (s.enabled) storage.set({ enabled: false })
                        },
                        e => plugin.reportError(e),
                )

                // The row hook needs the message list to be built after it is installed
                if (plugin.startedLate) {
                        plugin.requireReload()
                        return
                }

                // Fails closed: returns false when the message must not be sent
                const encryptOutgoing = (channelId: string, data: { content?: string } | undefined) => {
                        const plain = data?.content?.trim()
                        if (!data || !plain) return true
                        callNativeMethodSync('cozmicat123.e2ee.configure', [
                                !!storage.cache?.enabled,
                                storage.cache?.preset ?? 2,
                        ])
                        const selfId = (Stores as any).UserStore?.getCurrentUser?.()?.id ?? null
                        const res = callNativeMethodSync('cozmicat123.e2ee.encrypt', [channelId, plain, selfId])
                        if (res === null) return true // encryption off for this channel
                        if (res.error || !res.text) {
                                ToastActionCreators.open(ToastKey, { text: res.error ?? 'Encryption failed' })
                                return false
                        }
                        data.content = res.text
                        return true
                }

                cleanup(
                        getModules(withProps<MessageActions>('sendMessage', 'editMessage'), messages => {
                                cleanup(
                                        instead(messages, 'sendMessage', function (args, original) {
                                                // Blocked: return a promise like the async sendMessage hooks in fake-nitro fakeify.ts:39,59
                                                if (!encryptOutgoing(args[0], args[1])) return Promise.resolve()
                                                return Reflect.apply(original, this, args)
                                        }),
                                        instead(messages, 'editMessage', function (args, original) {
                                                if (!encryptOutgoing(args[0], args[2])) return Promise.resolve()
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
                                                if (m) decryptMessages([m], m.channelId)
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
                                if ((evt as any)?.message) decryptMessages([(evt as any).message])
                                return evt
                        }),
                        onFluxEventDispatched('MESSAGE_UPDATE', evt => {
                                if ((evt as any)?.message) decryptMessages([(evt as any).message])
                                return evt
                        }),
                        onFluxEventDispatched('LOAD_MESSAGES_SUCCESS', evt => {
                                const e = evt as any
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
