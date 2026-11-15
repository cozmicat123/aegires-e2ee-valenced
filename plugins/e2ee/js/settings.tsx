// AI-written glue (v1). Layout and components copied from human Valenced plugins:
//  - page shell and TextInput/Button: anonymous-file-names/js/settings.tsx:1-73
//  - TableSwitchRow: better-chat-buttons/js/settings.tsx:56-68
//  - TableRadioGroup/TableRadioRow: better-chat-buttons/js/settings.tsx:81-95
// Texts and rules mirror aliucord-e2ee@aegires-sync E2eeSettings.kt (password 8-256, preset radios).
import Page from '@valenced/components/Page'
import { Design } from '@valenced/discord/design'
import { callNativeMethod } from '@valenced/modules/native'
import { useEffect, useState } from 'react'
import { ScrollView, Text } from 'react-native'
import type { PluginSettingsComponent } from '@valenced/plugins/types'
import type { ComponentProps } from 'react'
import type { Settings } from '.'

const { Button, Stack, TableRadioGroup, TableRadioRow, TableRowGroup, TableSwitchRow, TextInput } = Design

type Props = ComponentProps<PluginSettingsComponent<{ jsonStorage: Settings }>>

export default function SettingsComponent({ api: { jsonStorage: storage } }: Props) {
        const { enabled, preset } = storage.use()!
        const [password, setPassword] = useState('')
        const [error, setError] = useState('')
        const [hasKey, setHasKey] = useState(false)
        const [busy, setBusy] = useState(false)

        useEffect(() => {
                callNativeMethod('cozmicat123.e2ee.hasKey', []).then(setHasKey, e => setError(String(e)))
        }, [])

        const setKey = async () => {
                setBusy(true)
                try {
                        const ok = await callNativeMethod('cozmicat123.e2ee.setKey', [password])
                        setError(ok ? '' : 'Password must be 8-256 characters')
                        setHasKey(ok)
                        if (ok) setPassword('')
                } catch (e) {
                        setError(String(e))
                } finally {
                        setBusy(false)
                }
        }

        return (
                <ScrollView keyboardShouldPersistTaps="handled">
                        <Page>
                                <Stack>
                                        <TextInput
                                                label="Password"
                                                placeholder="8-256 characters"
                                                defaultValue=""
                                                status={error ? 'error' : 'default'}
                                                errorMessage={error || undefined}
                                                onChange={setPassword}
                                        />
                                        <Button
                                                variant="primary"
                                                size="sm"
                                                text={busy ? 'Deriving key...' : 'Set key'}
                                                onPress={setKey}
                                        />
                                        <Button
                                                variant="secondary"
                                                size="sm"
                                                text="Clear key"
                                                onPress={() => {
                                                        callNativeMethod('cozmicat123.e2ee.clearKey', [])
                                                        setHasKey(false)
                                                }}
                                        />
                                        <Text>{hasKey ? 'Key set (kept in memory only).' : 'No key set.'}</Text>
                                </Stack>
                                <TableRowGroup title="Encryption">
                                        <TableSwitchRow
                                                label="Encrypt my messages"
                                                subLabel="Applies to the messages you send. You can read everyone else's messages regardless of profile. Preset channels always use AES-128-GCM."
                                                value={enabled}
                                                onValueChange={(v: boolean) => storage.set({ enabled: v })}
                                        />
                                </TableRowGroup>
                                <TableRadioGroup<number>
                                        title="Profile"
                                        defaultValue={preset}
                                        onChange={v => storage.set({ preset: v })}
                                >
                                        <TableRadioRow label="AES-128-GCM" value={0} />
                                        <TableRadioRow label="AES-192-GCM" value={1} />
                                        <TableRadioRow label="AES-256-GCM" value={2} />
                                </TableRadioGroup>
                        </Page>
                </ScrollView>
        )
}
