import { listTemplates } from "./initTemplates.js";
import { getPresetAgentDefinition } from "./presetAgents.js";
import { validateMiniprogramCapabilityBundle } from "./miniprogramScaffold.js";
import {
  DEFAULT_PROJECT_PROFILE_NAME,
  getProjectProfile,
} from "./projectProfiles.js";

const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface CapabilityVerificationMetadata {
  readonly entrypoint: string;
  readonly diagnosticLog: string;
}

export interface CapabilityAddonDefinition {
  readonly id: string;
  readonly description: string;
  /** Sandbox provider names this add-on supports (see InitService sandbox registry). */
  readonly compatibleSandboxProviders: readonly string[];
  /** When true, the add-on depends on host-local tools or state. */
  readonly requiresHostState?: boolean;
}

export interface CapabilityPackDefinition {
  readonly id: string;
  readonly description: string;
  readonly defaultTemplate?: string;
  readonly defaultProjectProfile?: string;
  readonly defaultPresetAgentIds?: readonly string[];
  readonly defaultVariant?: string;
  readonly compatibleTemplates?: readonly string[];
  readonly addons: readonly CapabilityAddonDefinition[];
  readonly verification?: CapabilityVerificationMetadata;
}

export interface CapabilityManifest {
  readonly version: number;
  readonly capability: string;
  readonly variant?: string;
  readonly addons: readonly string[];
  readonly verification?: CapabilityVerificationMetadata;
  readonly setupActions: readonly CapabilitySetupAction[];
}

export interface CapabilitySetupAction {
  readonly id: string;
  readonly status: "skipped" | "succeeded" | "failed";
  readonly reason?: string;
  readonly packageManager?: string;
  readonly command?: string;
  readonly summary?: string;
}

export const DEFAULT_CAPABILITY_PACK_ID = "generic";
export const MINIPROGRAM_CAPABILITY_PACK_ID = "miniprogram";

const GENERIC_CAPABILITY_PACK: CapabilityPackDefinition = {
  id: "generic",
  description:
    "Language-agnostic init with no domain-specific assumptions (current default behavior)",
  addons: [],
};

const MINIPROGRAM_CAPABILITY_PACK: CapabilityPackDefinition = {
  id: MINIPROGRAM_CAPABILITY_PACK_ID,
  description:
    "WeChat Mini Program development with verification entrypoint and native variant",
  defaultTemplate: "parallel-planner-with-review",
  defaultProjectProfile: "node",
  defaultPresetAgentIds: ["miniprogram"],
  defaultVariant: "native",
  compatibleTemplates: [
    "parallel-planner",
    "parallel-planner-with-review",
    "sequential-reviewer",
    "simple-loop",
    "blank",
  ],
  verification: {
    entrypoint: ".sandcastle/verify.sh",
    diagnosticLog: "debug/wx-check.log",
  },
  addons: [
    {
      id: "runtime-debug",
      description:
        "WeChat Developer Tools MCP runtime debugging (no-sandbox only)",
      compatibleSandboxProviders: ["no-sandbox"],
      requiresHostState: true,
    },
  ],
};

export const CAPABILITY_PACK_DEFINITIONS: readonly CapabilityPackDefinition[] =
  [GENERIC_CAPABILITY_PACK, MINIPROGRAM_CAPABILITY_PACK] as const;

export function listCapabilityPacksForInit(): {
  value: string;
  label: string;
  hint: string;
}[] {
  return CAPABILITY_PACK_DEFINITIONS.map((pack) => ({
    value: pack.id,
    label: pack.id,
    hint: pack.description,
  }));
}

export function getCapabilityPackDefinition(
  id: string,
): CapabilityPackDefinition | undefined {
  return CAPABILITY_PACK_DEFINITIONS.find((pack) => pack.id === id);
}

export interface CapabilityInitInputs {
  capabilityId?: string;
  explicitTemplate?: string;
  explicitProjectProfile?: string;
  explicitPresetAgentIds?: readonly string[];
  addonIds?: readonly string[];
  sandboxProviderName?: string;
}

export interface ResolvedCapabilityInit {
  readonly capabilityId: string;
  readonly variant?: string;
  readonly addonIds: readonly string[];
  readonly templateName: string;
  readonly projectProfileName: string;
  readonly presetAgentIds: readonly string[];
  readonly verification?: CapabilityVerificationMetadata;
  /** When true, init should write `.sandcastle/capability.json`. */
  readonly writeCapabilityManifest: boolean;
}

const DEFAULT_TEMPLATE_WHEN_UNSPECIFIED = "blank";

function coalesceInitValue<T>(
  explicit: T | undefined,
  packDefault: T | undefined,
  fallback: T,
): T {
  return explicit !== undefined ? explicit : (packDefault ?? fallback);
}

function validateSelectedCapabilityAddons(
  pack: CapabilityPackDefinition,
  addonIds: readonly string[],
  sandboxProviderName?: string,
): void {
  for (const addonId of addonIds) {
    const addon = pack.addons.find((candidate) => candidate.id === addonId);
    if (!addon) {
      throw new Error(
        `Unknown capability add-on "${addonId}" for capability pack "${pack.id}".`,
      );
    }
    if (
      sandboxProviderName &&
      !addon.compatibleSandboxProviders.includes(sandboxProviderName)
    ) {
      throw new Error(
        `Capability add-on "${addonId}" is not compatible with sandbox provider "${sandboxProviderName}". Supported: ${addon.compatibleSandboxProviders.join(", ")}.`,
      );
    }
  }
}

export interface CapabilityTemplateValidation {
  readonly allowed: true;
  /** Set when `blank` is allowed but requires manual verification wiring. */
  readonly blankTemplateWarning?: string;
}

function buildBlankTemplateCapabilityWarning(
  verification: CapabilityVerificationMetadata,
): string {
  return (
    "The blank template does not wire the capability verification entrypoint automatically. " +
    `Run \`${verification.entrypoint}\` from your workflow and read \`${verification.diagnosticLog}\` after Mini Program changes.`
  );
}

/** Validates explicit template selection against a capability pack's compatible template list. */
export function validateCapabilityTemplateSelection(
  capabilityId: string,
  templateName: string,
): CapabilityTemplateValidation {
  const pack = getCapabilityPackDefinition(capabilityId);
  if (pack?.compatibleTemplates === undefined) {
    return { allowed: true };
  }

  if (!pack.compatibleTemplates.includes(templateName)) {
    const supported = pack.compatibleTemplates.join(", ");
    throw new Error(
      `Template "${templateName}" is not compatible with capability pack "${capabilityId}". Supported templates: ${supported}`,
    );
  }

  if (templateName === "blank" && pack.verification !== undefined) {
    return {
      allowed: true,
      blankTemplateWarning: buildBlankTemplateCapabilityWarning(
        pack.verification,
      ),
    };
  }

  return { allowed: true };
}

export function resolveCapabilityInitOptions(
  inputs: CapabilityInitInputs,
): ResolvedCapabilityInit {
  const explicitCapability = inputs.capabilityId?.trim();
  const capabilityId = explicitCapability || DEFAULT_CAPABILITY_PACK_ID;
  const pack = getCapabilityPackDefinition(capabilityId);
  if (!pack) {
    throw new Error(`Unknown capability pack "${capabilityId}".`);
  }

  const addonIds = inputs.addonIds ?? [];
  validateSelectedCapabilityAddons(pack, addonIds, inputs.sandboxProviderName);

  return {
    capabilityId: pack.id,
    variant: pack.defaultVariant,
    addonIds,
    templateName: coalesceInitValue(
      inputs.explicitTemplate,
      pack.defaultTemplate,
      DEFAULT_TEMPLATE_WHEN_UNSPECIFIED,
    ),
    projectProfileName: coalesceInitValue(
      inputs.explicitProjectProfile,
      pack.defaultProjectProfile,
      DEFAULT_PROJECT_PROFILE_NAME,
    ),
    presetAgentIds: coalesceInitValue(
      inputs.explicitPresetAgentIds,
      pack.defaultPresetAgentIds,
      [],
    ),
    verification: pack.verification,
    writeCapabilityManifest: explicitCapability !== undefined,
  };
}

export function buildCapabilityManifest(
  resolved: ResolvedCapabilityInit,
  setupActions: readonly CapabilitySetupAction[] = [],
): CapabilityManifest {
  return {
    version: 1,
    capability: resolved.capabilityId,
    ...(resolved.variant !== undefined ? { variant: resolved.variant } : {}),
    addons: [...resolved.addonIds],
    ...(resolved.verification !== undefined
      ? { verification: resolved.verification }
      : {}),
    setupActions: [...setupActions],
  };
}

function validateCapabilityPackReferences(
  pack: CapabilityPackDefinition,
  templateNames: Set<string>,
): void {
  if (
    pack.defaultTemplate !== undefined &&
    !templateNames.has(pack.defaultTemplate)
  ) {
    throw new Error(
      `Capability pack "${pack.id}" references unknown default template "${pack.defaultTemplate}"`,
    );
  }

  if (
    pack.defaultProjectProfile !== undefined &&
    !getProjectProfile(pack.defaultProjectProfile)
  ) {
    throw new Error(
      `Capability pack "${pack.id}" references unknown default project profile "${pack.defaultProjectProfile}"`,
    );
  }

  if (pack.defaultPresetAgentIds !== undefined) {
    for (const presetId of pack.defaultPresetAgentIds) {
      if (!getPresetAgentDefinition(presetId)) {
        throw new Error(
          `Capability pack "${pack.id}" references unknown preset agent "${presetId}"`,
        );
      }
    }
  }

  if (pack.compatibleTemplates !== undefined) {
    for (const templateName of pack.compatibleTemplates) {
      if (!templateNames.has(templateName)) {
        throw new Error(
          `Capability pack "${pack.id}" lists unknown compatible template "${templateName}"`,
        );
      }
    }
  }
}

function validateCapabilityPackAddons(pack: CapabilityPackDefinition): void {
  const addonIds = new Set<string>();
  for (const addon of pack.addons) {
    if (!ID_PATTERN.test(addon.id)) {
      throw new Error(
        `Invalid capability add-on id "${addon.id}" on pack "${pack.id}"`,
      );
    }
    if (addonIds.has(addon.id)) {
      throw new Error(
        `Duplicate capability add-on id "${addon.id}" on pack "${pack.id}"`,
      );
    }
    addonIds.add(addon.id);
    if (addon.compatibleSandboxProviders.length === 0) {
      throw new Error(
        `Capability add-on "${addon.id}" on pack "${pack.id}" must declare compatible sandbox providers`,
      );
    }
  }
}

/** Validates capability pack registry shape and cross-registry references. */
export function validateCapabilityRegistries(): void {
  const packIds = new Set<string>();
  const templateNames = new Set(
    listTemplates().map((template) => template.name),
  );

  for (const pack of CAPABILITY_PACK_DEFINITIONS) {
    if (!ID_PATTERN.test(pack.id)) {
      throw new Error(`Invalid capability pack id: "${pack.id}"`);
    }
    if (packIds.has(pack.id)) {
      throw new Error(`Duplicate capability pack id: "${pack.id}"`);
    }
    packIds.add(pack.id);

    validateCapabilityPackReferences(pack, templateNames);
    validateCapabilityPackAddons(pack);
  }

  validateMiniprogramCapabilityBundle();
}
