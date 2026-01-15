const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
    entry: {
        background: './background.js',
        offscreen: './offscreen.js',
        content: './content.js',
        popup: './popup.js'
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].js',
        clean: true
    },
    module: {
        rules: [
            {
                test: /\.js$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: ['@babel/preset-env']
                    }
                }
            }
        ]
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                { from: 'manifest.json', to: 'manifest.json' },
                { from: 'popup.html', to: 'popup.html' },
                { from: 'popup.css', to: 'popup.css' },
                { from: 'offscreen.html', to: 'offscreen.html' },
                { from: 'icons', to: 'icons', noErrorOnMissing: true }
            ]
        })
    ],
    resolve: {
        extensions: ['.js']
    },
    optimization: {
        splitChunks: false
    },
    experiments: {
        topLevelAwait: true
    }
};
