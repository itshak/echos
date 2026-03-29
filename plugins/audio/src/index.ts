import type { EchosPlugin, PluginContext } from '@echos/core';
import { createSaveAudioTool } from './tool.js';

const audioPlugin: EchosPlugin = {
  name: 'audio',
  description: 'Podcast and audio file transcription via OpenAI Whisper',
  version: '0.1.0',

  setup(context: PluginContext) {
    return { tools: [createSaveAudioTool(context)] };
  },
};

export default audioPlugin;
