import { getProjectProfile, listProjectProfiles } from "./projectProfiles.js";

export const renderBootstrapScript = (profileName: string): string => {
  const profile = getProjectProfile(profileName);
  if (!profile) {
    const available = listProjectProfiles()
      .map((entry) => entry.name)
      .join(", ");
    throw new Error(
      `Unknown project profile "${profileName}". Available: ${available}`,
    );
  }
  return profile.bootstrapScript;
};
