const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    background: './src/background.ts',
    content: './src/content/index.ts',
    sidepanel: './src/sidepanel/index.ts',
    settings: './src/settings/index.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
  resolve: { extensions: ['.ts', '.js'] },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json' },
        { from: 'src/sidepanel/index.html', to: 'sidepanel.html' },
        { from: 'src/settings/index.html', to: 'settings.html' },
      ],
    }),
  ],
};
