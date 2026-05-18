import {
  formatProjectProfileNames,
  getProjectProfile,
} from "./projectProfiles.js";

export const renderBootstrapScript = (profileName: string): string => {
  const profile = getProjectProfile(profileName);
  if (!profile) {
    throw new Error(
      `Unknown project profile "${profileName}". Available: ${formatProjectProfileNames()}`,
    );
  }
  return profile.bootstrapScript;
};
