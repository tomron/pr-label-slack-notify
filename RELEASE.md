# Release process

1. Update `package.json` version and lockfile.
2. Run `npm ci --ignore-scripts`, `npm run check`, and `npm audit`.
3. Commit the source and rebuilt `dist/`; push to main and wait for CI to pass.
4. Run the manual Release workflow with the same semantic version. It validates main, runs checks, verifies the bundle, then creates `vX.Y.Z`, moves `vX`, and creates a GitHub release.
5. Never move a published full-version tag. Only the major tag moves on compatible releases.
6. For Marketplace, make the repository public only after owner approval, open the GitHub release editor and select "Publish this Action to the GitHub Marketplace". The repository owner must review/accept the Marketplace developer agreement and choose categories if prompted. Save the release and verify the resulting Marketplace listing.

The repository must contain a root `action.yml`, README, license and committed bundle. Marketplace publication is a separate step from creating a GitHub release. A release without the Marketplace checkbox is not a Marketplace listing.

For the initial release, use v1.0.0 and v1 after green CI. Review the README examples and test results first. No live Slack test is part of the release workflow.
