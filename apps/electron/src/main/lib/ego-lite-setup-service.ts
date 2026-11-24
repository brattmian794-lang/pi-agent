import { join } from 'node:path'
import type { EgoSetupState } from '@proma/shared'
import { getConfigDir } from './config-paths'
import { readJsonFileSafe, writeTextFileAtomic } from './safe-file'
import { getSettings, updateSettings } from './settings-service'
import { createEgoLiteSetup } from './ego-lite-setup'
import { ensureEgoLiteInstalled } from './ego-lite-installer'
import { ensureEgoLiteProfile, probeEgoLite } from './ego-lite-runtime'

const journal = () => join(getConfigDir(), 'ego-lite-setup.json')

export const egoLiteSetup = createEgoLiteSetup({
  install: ensureEgoLiteInstalled,
  verify: probeEgoLite,
  configure: (workspaceId, signal) => ensureEgoLiteProfile(workspaceId, signal, getSettings().egoLiteProfileMode ?? 'current'),
  enable: () => { updateSettings({ egoLiteEnabled: true }) },
  load: () => readJsonFileSafe<EgoSetupState>(journal()),
  save: state => writeTextFileAtomic(journal(), JSON.stringify(state)),
})
