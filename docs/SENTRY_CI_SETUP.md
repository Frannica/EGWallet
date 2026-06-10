Sentry CI setup

1) Do NOT store auth tokens in the repository.

2) Create an Auth Token in Sentry with these scopes:
   - project:read
   - project:write
   - org:read
   - release:admin

3) Add the token as a CI secret named `SENTRY_AUTH_TOKEN`.

GitHub Actions example (workflow snippet):

```yaml
env:
  SENTRY_ORG: egwallet-hu
  SENTRY_PROJECT: react-native
  NODE_ENV: production

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 18
      - name: Install
        run: yarn install --frozen-lockfile
      - name: Build Android bundle (with Sentry upload)
        env:
          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
          SENTRY_ORG: ${{ secrets.SENTRY_ORG }}
          SENTRY_PROJECT: ${{ secrets.SENTRY_PROJECT }}
        run: |
          cd android
          ./gradlew clean bundleRelease -PreactNativeArchitectures=armeabi-v7a,arm64-v8a -Pandroid.disableLint=true --no-daemon
```

4) Verify uploads by checking Sentry Releases in the Sentry web UI for your `react-native` project under the `egwallet-hu` org.

5) Rotate the token if it was committed to the repo, and delete the committed token from history.
