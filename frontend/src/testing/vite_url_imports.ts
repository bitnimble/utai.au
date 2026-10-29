import { plugin } from 'bun';

// `bun test` preload: Vite resolves `x?url` / `x?worker&url` imports to the
// asset's URL; give unit tests the same default-export string.
plugin({
  name: 'vite-url-imports',
  setup(build) {
    build.onResolve({ filter: /\?(worker&)?url$/ }, (args) => ({
      path: args.path,
      namespace: 'vite-url',
    }));
    build.onLoad({ filter: /.*/, namespace: 'vite-url' }, (args) => ({
      contents: `export default ${JSON.stringify(args.path)};`,
      loader: 'js',
    }));
  },
});
