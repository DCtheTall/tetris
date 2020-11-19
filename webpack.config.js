  const {join, resolve} = require('path');

module.exports = {
  devtool: 'source-map',
  entry: join(resolve('.'), 'src/main.ts'),
  target: 'web',
  output: {
    path: join(resolve('.'), 'dist/'),
    filename: 'index.js',
  },
  resolve: {
    extensions: ['.ts', '.js', '.d.ts'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {loader: 'ts-loader'},
      },
    ],
  },
};
