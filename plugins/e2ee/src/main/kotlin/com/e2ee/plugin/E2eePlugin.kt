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
            if (password.length !in 8..256) {
                false
            } else {
                E2ee.key = Crypto.deriveKey(password)
                true
            }
        }

        registerNativeMethod("$id.clearKey") { _ ->
            E2ee.key = null
            Unit
        }

        registerNativeMethod("$id.hasKey") { _ -> E2ee.key != null }

        // [channelId, plain, selfId?] -> { text?: String, error?: String }, or null when encryption is off for the channel
        registerNativeMethod("$id.encrypt") { args ->
            val channelId = args[0] as String
            if (!E2ee.encryptOn(channelId)) {
                null
            } else {
                val (text, error) = E2ee.encryptText(channelId, args[1] as String, args[2] as String?)
                mapOf("text" to text, "error" to error)
            }
        }

        // [[content, channelId, authorId?], ...] -> [plain | null, ...]; null = leave the message as is
        registerNativeMethod("$id.decrypt") { args ->
            (args[0] as List<*>).map { item ->
                val (content, channelId, author) = (item as List<*>)
                val k = E2ee.keyFor(channelId as String)
                if (k == null || content !is String || !Crypto.looksEncrypted(content)) {
                    null
                } else {
                    Crypto.decrypt(content, k, channelId, author as String?)
                }
            }
        }
    }

    stop {
        E2ee.key = null
        E2ee.enabled = false
    }
}
