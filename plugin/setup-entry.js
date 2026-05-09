import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { wristclawPlugin } from "./channel-plugin-api.js";

export default defineSetupPluginEntry(wristclawPlugin);
