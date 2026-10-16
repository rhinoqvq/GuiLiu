// Which build is running. The source repos are the development build: the sidebar marks it Beta with the version
// the next release will carry. Packaging rewrites this file as the release build of the version being published.
// After publishing a version, set `version` here to the one after it (0.1.1 published -> 0.1.2).
// The rc series ended at 0.1.0-rc.15; 0.1.1 is the first regular release.
export const BUILD = Object.freeze({ channel: 'release', version: "0.1.2" });

export const isBetaBuild = (build = BUILD) => build.channel === 'beta';
// The browser tab says which build it is: GUILIU, or GUILIU beta for the development build.
export const pageTitle = (build = BUILD) => isBetaBuild(build) ? 'GUILIU beta' : 'GUILIU';
