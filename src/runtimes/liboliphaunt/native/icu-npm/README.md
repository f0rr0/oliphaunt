# @oliphaunt/icu

Optional ICU data and matching PostgreSQL catalog seeds for native Node, Bun,
Deno, and React Native. Install this package when you need ICU collations:

```sh
npm install @oliphaunt/icu
```

```ts
import icu from '@oliphaunt/icu';

const db = await Oliphaunt.open({ icu });
```

Import `Oliphaunt` from your SDK. Installing the package makes its resources
available; passing the descriptor selects ICU for that database.

The package owns `OliphauntICU.bundle/share/icu` and the matching seeds under
`OliphauntICU.bundle/native-seeds`. The SDK resolves the current platform and
validates the seed against the data. Base runtime packages carry the standard
seed only.

The React Native Expo plugin discovers this installed dependency and stages
its resources into the app. No additional plugin option or separate pod is
needed. Native Node, Bun, and Deno resolve resources from the imported package.
