// AI-written glue (v1). Shared by index.ts and settings.tsx so they do not import each other.
// redecrypt after Set key: valenced-community-plugins valid-user/js/index.ts:54-83 (redrawMentions)
import { Dispatcher } from '@valenced/discord/common/flux'
import { Stores } from '@valenced/discord/flux'
import { callNativeMethodSync } from '@valenced/modules/native'
import type { DiscordModules } from '@valenced/discord/types'

// Flux message objects (snake_case, as sent by the gateway)
export interface FluxMessage {
        id?: string
        content?: string
        channel_id?: string
        author?: { id?: string }
        referenced_message?: FluxMessage | null
}

// Ids of messages that were sent encrypted (Aegires Message.encrypted). Capped so it cannot grow forever.
export const encryptedIds = new Set<string>()
const MAX_IDS = 5000

// Same test as Crypto.looksEncrypted (Crypto.java: PREFIX line 65, looksEncrypted 83-85; pinned dddead0 "\u00A7"). Checked here so plain rows never cross the bridge.
const looksEncrypted = (s: unknown): s is string => typeof s === 'string' && s.startsWith('\u00A7')

// Replace encrypted content in place. The message and its reply preview go in one native call.
export function decryptMessages(messages: FluxMessage[], fallbackChannel?: string) {
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
