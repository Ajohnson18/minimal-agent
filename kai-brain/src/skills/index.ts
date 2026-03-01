/**
 * Skills Module
 *
 * Provides skill discovery and loading for AVA agent.
 */
export { loadSkills, discoverSkills, formatSkillsForPrompt } from "./loader.js";
export { getSkillDirectories, getAllSkillPaths, SKILLS_DIR } from "./config.js";
export type { Skill, SkillSummary } from "./loader.js";
