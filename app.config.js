export default ({ config }) => ({
  ...config,
  name: "EGWallet",
  slug: "EGWalletSimple",
  version: "1.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  newArchEnabled: true,
  splash: {
    image: "./assets/splash-icon.png",
    resizeMode: "contain",
    backgroundColor: "#ffffff"
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.egwallet.simple"
  },
  android: {
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#ffffff"
    },
    edgeToEdgeEnabled: true,
    package: "com.francisco1953.egwalletmobile",
    versionCode: 61
  },
  web: {
    favicon: "./assets/favicon.png"
  },
  androidStatusBar: {
    barStyle: "dark-content"
  },
  extra: {
    eas: {
      projectId: "16aa669e-bf87-4a8b-b24b-6b1c79dcc0f7"
    }
  },
  owner: "francisco1953",
  plugins: [
    "expo-notifications",
    ["@sentry/react-native/expo", {
      "organization": process.env.SENTRY_ORG || "egwallet-hu",
      "project": process.env.SENTRY_PROJECT || "react-native",
      "authToken": process.env.SENTRY_AUTH_TOKEN
    }]
  ]
});
