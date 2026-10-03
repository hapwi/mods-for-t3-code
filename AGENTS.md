<!-- hap-changelog-start -->

## Changelog

Maintain CHANGELOG.md for every code, configuration, or documentation change,
including small changes. Create it if missing.

Group related edits into one concise, user-facing entry under [Unreleased], using
Added, Changed, Deprecated, Removed, Fixed, or Security as appropriate.

Mark breaking changes explicitly and include migration guidance when needed.
Preserve existing release history and unrelated entries. Record completed changes,
not planned work or unperformed checks.

## Release management

Prepare a release only when the user requests one. Ordinary development updates
CHANGELOG.md under [Unreleased] without changing the project version or moving
entries into a release section.

For an authorized release, derive the SemVer increment from the included changes
and use YYYY-MM-DD dates. Creating or pushing tags, publishing a release, and
deploying require authorization for those actions.

<!-- hap-changelog-end -->
