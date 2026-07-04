import { createClient } from '@supabase/supabase-js'
import { existsSync, readFileSync } from 'node:fs'

const AUTH_EMAIL_DOMAIN = 'accounts.sygshift.invalid'
const USERNAME_PATTERN = /^[a-z][a-z0-9]{1,62}$/

function loadLocalEnvironment() {
  if (!existsSync('.env.local')) return

  const lines = readFileSync('.env.local', 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) continue

    const key = trimmed.slice(0, separatorIndex).trim()
    const rawValue = trimmed.slice(separatorIndex + 1).trim()
    const value = rawValue.replace(/^['"]|['"]$/g, '')

    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

function readRequiredEnv(name, fallbackName) {
  const value = process.env[name]?.trim() || (fallbackName ? process.env[fallbackName]?.trim() : '')
  if (!value) {
    throw new Error(`${name}${fallbackName ? ` or ${fallbackName}` : ''} is required.`)
  }
  return value
}

function normalizeUsername(username) {
  return username.trim().toLowerCase()
}

function usernameToAuthEmail(username) {
  const normalizedUsername = normalizeUsername(username)
  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    throw new Error('The bootstrap username is not valid.')
  }
  return `${normalizedUsername}@${AUTH_EMAIL_DOMAIN}`
}

async function findUserByEmail(supabase, email) {
  const perPage = 200

  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage })
    if (error) throw new Error(`Existing auth users could not be checked: ${error.message}`)

    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email)
    if (user) return user
    if (data.users.length < perPage) return null
  }

  throw new Error('Existing auth user check exceeded the expected account count.')
}

async function main() {
  loadLocalEnvironment()

  const supabaseUrl = readRequiredEnv('SUPABASE_URL', 'VITE_SUPABASE_URL')
  const serviceRoleKey = readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY')
  const username = normalizeUsername(process.env.SYGSHIFT_BOOTSTRAP_USERNAME ?? 'jbrown')
  const password = readRequiredEnv('SYGSHIFT_BOOTSTRAP_PASSWORD')
  const firstName = process.env.SYGSHIFT_BOOTSTRAP_FIRST_NAME?.trim() || 'Jordan'
  const lastName = process.env.SYGSHIFT_BOOTSTRAP_LAST_NAME?.trim() || 'Brown'
  const authEmail = usernameToAuthEmail(username)

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

  let user = await findUserByEmail(supabase, authEmail)
  let createdAuthUser = false

  if (!user) {
    const created = await supabase.auth.admin.createUser({
      email: authEmail,
      password,
      email_confirm: true,
      user_metadata: { username },
      app_metadata: { username, source: 'sygshift-bootstrap' },
    })

    if (created.error) {
      throw new Error(`Bootstrap auth user could not be created: ${created.error.message}`)
    }

    user = created.data.user
    createdAuthUser = true
  }

  const registered = await supabase.rpc('register_bootstrap_admin', {
    p_auth_user_id: user.id,
    p_first_name: firstName,
    p_last_name: lastName,
    p_requested_username: username,
  })

  if (registered.error) {
    if (createdAuthUser) {
      await supabase.auth.admin.deleteUser(user.id)
    }

    throw new Error(`Bootstrap admin could not be registered: ${registered.error.message}`)
  }

  console.log(`Bootstrap admin is ready for username "${username}".`)
  console.log('The temporary password must be replaced at first sign-in, then MFA must be verified.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Bootstrap failed.')
  process.exit(1)
})
