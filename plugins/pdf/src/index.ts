import type { EchosPlugin, PluginContext } from '@echos/core';
import { createSavePdfTool } from './tool.js';

const pdfPlugin: EchosPlugin = {
  name: 'pdf',
  description: 'PDF file extraction and saving using pdf-parse',
  version: '0.1.0',

  setup(context: PluginContext) {
    return { tools: [createSavePdfTool(context)] };
  },
};

export default pdfPlugin;
