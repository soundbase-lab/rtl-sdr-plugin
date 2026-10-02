---
name: Bug report
about: The plugin does something wrong, or a dongle does not work with it
labels: bug
---

**What happened**

**What you expected**

**Dongle and tuner chip** (the two lines `rtl_test` prints, e.g. `Nooelec, NESDR SMArt v5` and `Found Rafael Micro R820T tuner`)

**Reproduction**

```sh
# the commands you ran
```

**Output of `npm run doctor`**

```
# this covers the setup: Node, the SDK, the manifest, the adapter, the licence
```

**Output of `npm run smoke`**

```
# paste it — this tells us whether the plugin booted and handshaked at all
```

**Your `soundbase` block from `package.json`**

```json
```

That block records which template release you started from and which contract
version it targets. Without it we are guessing.
