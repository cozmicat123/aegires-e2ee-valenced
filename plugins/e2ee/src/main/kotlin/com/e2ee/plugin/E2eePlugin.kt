@file:JvmName("E2eePlugin")

// AI-written glue (v1). Logic ported from cozmicat123/aliucord-e2ee@aegires-sync E2eePlugin.kt `object E2ee`
// (keyFor/presetFor/encryptOn/encryptText), which itself mirrors Aegires MessageListScreen + MessageCryptoHelper.
// Plugin/bridge structure: Valenced/valenced-plugin-template example-plugin MyPlugin.kt.
// Crypto, ForcedKeys, Argon2id, Blake2b are vendored verbatim from Aegires and not touched here.
package com.e2ee.plugin

import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeAsyncMethod
import app.valenced.xposed.api.registerNativeMethod
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.SecretKey

private object E2ee {
    @Volatile var key: SecretKey? = null
    @Volatile var enabled = false
    @Volatile var preset: Crypto.Preset = Crypto.Preset.AES256

    // Forced-channel keys are derived once per channel; never start two 64 MiB derivations for one channel
    private val preparing = ConcurrentHashMap.newKeySet<String>()

    fun isForced(channelId: String) = ForcedKeys.isForced(channelId)

    fun keyFor(channelId: String): SecretKey? {
        if (!isForced(channelId)) return key
        ForcedKeys.keyFor(channelId)?.let { return it }
        if (preparing.add(channelId)) ForcedKeys.prepare(channelId) { preparing.remove(channelId) }
        return null
    }

    fun presetFor(channelId: String): Crypto.Preset =
        if (isForced(channelId)) Crypto.Preset.AES128 else preset

    fun encryptOn(channelId: String): Boolean = isForced(channelId) || enabled

    // Same checks and messages as the Aliucord plugin. Returns text, or the message to show the user.
    fun encryptText(channelId: String, plain: String, sender: String?): Pair<String?, String?> {
        val k = keyFor(channelId)
            ?: return null to (if (isForced(channelId)) "Encryption key not ready yet" else "Encryption key missing")
        if (sender == null) return null to "Not ready yet, try again in a moment"
        val p = presetFor(channelId)
        val max = Crypto.maxPlaintextBytes(p)
        if (Crypto.utf8Length(plain) > max) return null to "Too long for ${p.label} (max $max bytes)"
        val out = Crypto.encrypt(plain, k, p, channelId, sender) ?: return null to "Encryption failed"
        return out to null
    }
}

val e2eePlugin = plugin {
    start {
        val id = manifest.id

        // [enabled: Boolean, preset: Int]
        registerNativeMethod("$id.configure") { args ->
            E2ee.enabled = args[0] as Boolean
            E2ee.preset = Crypto.Preset.fromIndex((args[1] as Number).toInt()) ?: Crypto.Preset.AES256
            Unit
        }

        // [password: String] -> Boolean. Argon2id is heavy, so this runs off the RN thread.
        registerNativeAsyncMethod("$id.setKey") { args ->
            val password = args[0] as String
            // deriveKey returns null on any failure (Crypto.java derive, line 99 on); keep the old key then
            val derived = if (password.length in 8..256) Crypto.deriveKey(password) else null
            if (derived != null) E2ee.key = derived
            derived != null
        }

        registerNativeMethod("$id.clearKey") { _ ->
            E2ee.key = null
            Unit
        }

        registerNativeMethod("$id.hasKey") { _ -> E2ee.key != null }

        // [channelId, plain, selfId?] -> { text?: String, error?: String }, or null when encryption is off for the channel
        registerNativeMethod("$id.encrypt") { args ->
            val channelId = args[0] as String
            val plain = args[1] as String
            // Same as Aliucord encryptOutgoing: never double-encrypt
            if (!E2ee.encryptOn(channelId) || Crypto.looksEncrypted(plain)) {
                null
            } else {
                val (text, error) = E2ee.encryptText(channelId, plain, args[2] as String?)
                mapOf("text" to text, "error" to error)
            }
        }

        // [[content, channelId, authorId?], ...] -> [{ text: plain | null, enc: Boolean }, ...]
        // text null = leave the message as is. enc = looksEncrypted(content), same rule as Aegires Message.encrypted.
        registerNativeMethod("$id.decrypt") { args ->
            (args[0] as List<*>).map { item ->
                val (content, channelId, author) = (item as List<*>)
                val enc = content is String && Crypto.looksEncrypted(content)
                val k = E2ee.keyFor(channelId as String)
                val text = if (k == null || !enc) null else Crypto.decrypt(content as String, k, channelId, author as String?)
                mapOf("text" to text, "enc" to enc)
            }
        }
    }

    stop {
        E2ee.key = null
        E2ee.enabled = false
    }
}
