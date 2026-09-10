// pm2 config for the engine on a laptop or a small box: `pm2 start ecosystem.config.cjs`.
// Reads apps/engine/.env (the engine loads it itself). Restarts are safe: the loop
// re-reads chain state before sending createEvent or resolve, so a bounce never
// duplicates an on-chain event or a resolution.
module.exports = {
  apps: [
    {
      name: "twic-engine",
      cwd: __dirname,
      script: "node_modules/.bin/tsx",
      args: "src/index.ts",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      kill_timeout: 15000,
      out_file: "logs/engine.out.log",
      error_file: "logs/engine.err.log",
      time: true,
    },
  ],
};
