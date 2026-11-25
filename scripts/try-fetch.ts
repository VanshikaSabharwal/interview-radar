/**
 * Debug helper: run ONE Google Jobs search and print the parsed jobs.
 * Needs only SEARCHAPI_API_KEY.
 *
 *   npm run fetch -- "frontend intern" "Bengaluru, Karnataka, India"
 *   npm run fetch -- "frontend intern" remote
 */
import { config } from "../radar.config.js";
import { fetchJobs } from "../src/searchapi.js";

const [query = "frontend intern", location = "Bengaluru, Karnataka, India"] = process.argv.slice(2);

console.log(`Searching "${query}" in ${location}...`);
const jobs = await fetchJobs({ query, location, country: config.defaultCountry });
console.table(jobs.map(({ title, company, location, postedAt }) => ({ title, company, location, postedAt })));
console.log(`${jobs.length} jobs. First one in full:`, jobs[0]);
