import { IconKey, IconLock, IconSun, IconUser } from '../../ui/icons'

/**
 * The groups the profile page is split into, in menu order. One is shown at a time,
 * named by the route: `#/profile/tokens`. A bare `#/profile` opens the first.
 */
export const PROFILE_SECTIONS = [
  { id: 'account', label: 'Account', Icon: IconUser },
  { id: 'security', label: 'Sign-in and security', Icon: IconLock },
  { id: 'tokens', label: 'Assistants and tokens', Icon: IconKey },
  { id: 'preferences', label: 'Preferences', Icon: IconSun },
] as const

export type SectionId = (typeof PROFILE_SECTIONS)[number]['id']

export function isSectionId(value: string | undefined): value is SectionId {
  return PROFILE_SECTIONS.some((candidate) => candidate.id === value)
}

export type SettingEntry = {
  /** The card's id on the profile page, as `setting-<id>`, and the route's last segment. */
  id: string
  section: SectionId
  /** The card's heading, word for word, so a result reads as what you will land on. */
  label: string
  /** Other words someone might reach for. Searched, never shown. */
  keywords: string
}

/**
 * Every card on the profile page, for the sidebar's jump search.
 *
 * Kept beside the section list rather than generated from the page, because the page
 * shows one section at a time and the search has to find cards in the ones that are
 * not on screen. Adding a card to the profile means adding it here, or it is a setting
 * nobody can search for.
 */
export const SETTINGS: readonly SettingEntry[] = [
  { id: 'display-name', section: 'account', label: 'Display name', keywords: 'name rename me' },
  { id: 'picture', section: 'account', label: 'Picture', keywords: 'avatar photo image face' },
  {
    id: 'sign-in',
    section: 'security',
    label: 'Sign-in',
    keywords: 'password email login linked accounts google github provider',
  },
  {
    id: 'sessions',
    section: 'security',
    label: 'Sessions',
    keywords: 'devices browsers signed in log out others',
  },
  { id: 'log-out', section: 'security', label: 'Log out', keywords: 'sign out logout exit' },
  {
    id: 'create-token',
    section: 'tokens',
    label: 'Create a token',
    keywords: 'api key access token assistant connect new',
  },
  {
    id: 'your-tokens',
    section: 'tokens',
    label: 'Your tokens',
    keywords: 'api keys access tokens revoke assistants connected',
  },
  {
    id: 'appearance',
    section: 'preferences',
    label: 'Appearance',
    keywords: 'theme dark light mode colour color system',
  },
  { id: 'lea-paper', section: 'preferences', label: 'Lea paper', keywords: 'diary kraft ruled paper stock' },
  {
    id: 'interface-font',
    section: 'preferences',
    label: 'Interface font',
    keywords: 'typeface text ui font',
  },
  {
    id: 'canvas-font',
    section: 'preferences',
    label: 'Canvas font',
    keywords: 'typeface text glade shapes font default',
  },
]

/** Where a setting lives in the address bar. */
export function settingPath(entry: SettingEntry): string {
  return `#/profile/${entry.section}/${entry.id}`
}
