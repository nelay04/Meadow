import { IconGitHub, IconGoogle } from '../../ui/icons'
import type { OAuthProvider } from '../../lib/api'

type ProviderChrome = {
  id: OAuthProvider
  label: string
  Icon: (props: { size?: number }) => React.ReactElement
}

/**
 * The provider list the sign-in and profile screens both render from.
 *
 * One place, so a button, its icon and the sentence naming it in an error can never
 * disagree, and so adding a third provider is an entry here rather than an edit in
 * three screens. The order is the order the buttons appear in.
 *
 * Whether a provider is actually available is a server answer (`/auth/providers`),
 * never assumed from this list: the credentials are environment variables the browser
 * never sees, and a button that redirects into a 404 is worse than no button.
 */
export const OAUTH_PROVIDERS: readonly ProviderChrome[] = [
  { id: 'github', label: 'GitHub', Icon: IconGitHub },
  { id: 'google', label: 'Google', Icon: IconGoogle },
]

export function providerLabel(id: string): string {
  return OAUTH_PROVIDERS.find((provider) => provider.id === id)?.label ?? id
}
