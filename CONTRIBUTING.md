# Contributing

Thanks for your interest in `dsh-mermaid`.

## Development setup

```sh
npm install
npm run build   # rebuild client.js from client.src.js
npm test        # jsdom smoke test, no DSH install required
```

`client.js` is committed on purpose so the plugin can be installed without a
build step. CI rebuilds it and fails when the committed bundle differs from
`client.src.js`, so **always run `npm run build` and commit `client.js` with
your source change**.

## What to keep in mind

- The plugin is a DOM enhancement: it must never remove or reparent nodes that
  React owns. Add siblings, and compare before writing attributes.
- Detection relies on the plain-code branch plus `pele`'s `detectType()`. If a
  DSH release starts exposing the fence language in the DOM, prefer that.
- Public anchors used: `.md-code-block`, `[data-code-block-banner]`,
  `[data-code-block-content]`, and DSH's icon sprite ids (`dsw-icon-*`). Other
  class names are CSS-module hashes and must not be used.
- Keep user-facing copy short and consistent with DSH's own UI.

## Commit & pull requests

- One logical change per pull request.
- Describe the user-visible effect and how you verified it (screenshots for UI
  changes are welcome).
- Update `CHANGELOG.md` for user-visible changes.

## License

By contributing you agree that your contribution is licensed under the MIT
License (see `LICENSE`). Third-party code keeps its own license (see
`THIRD_PARTY_NOTICES.md`).
