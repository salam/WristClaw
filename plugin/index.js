import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { wristclawPlugin } from "./channel-plugin-api.js";

export default defineChannelPluginEntry({
  id: "wristclaw",
  name: "WristClaw",
  description: "WristClaw Apple Watch channel",
  plugin: wristclawPlugin
});
