// One-time local key generation. Outputs remain in the ignored secrets directory.
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const directory = resolve('secrets')
const file = resolve(directory, 'push-delivery.json')
mkdirSync(directory, { recursive: true })
if (!existsSync(file)) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const key = pair.privateKey.export({ format: 'jwk' })
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(key.x, 'base64url'), Buffer.from(key.y, 'base64url')]).toString('base64url')
  writeFileSync(file, JSON.stringify({ SYGSHIFT_PUSH_PUBLIC_KEY: publicKey, SYGSHIFT_PUSH_PRIVATE_KEY: key.d, SYGSHIFT_PUSH_HOOK_SECRET: randomBytes(32).toString('base64url') }), { flag: 'wx', mode: 0o600 })
}
const values = JSON.parse(readFileSync(file, 'utf8'))
if (!/^[A-Za-z0-9_-]{43}$/.test(values.SYGSHIFT_PUSH_HOOK_SECRET)) throw new Error('Invalid local push credential format')
const secret = values.SYGSHIFT_PUSH_HOOK_SECRET
const sql = `begin;\ndo $$ begin\n if exists(select 1 from vault.decrypted_secrets where name='sygshift_push_hook' and decrypted_secret <> '${secret}') then raise exception 'Existing push credential differs; rotation requires a separate release.'; end if;\n if not exists(select 1 from vault.secrets where name='sygshift_push_hook') then perform vault.create_secret('${secret}','sygshift_push_hook','Authenticated SygShift push-delivery wakeup'); end if;\nend $$;\ncommit;\nselect exists(select 1 from vault.secrets where name='sygshift_push_hook') as configured;\n`
writeFileSync(resolve(directory, 'register-push-hook.sql'), sql, { mode: 0o600 })
console.log('Push credentials prepared in ignored local files; no credential values displayed.')
