/**
 * @file route manager
 * @author *__ author __*{% if: *__ email __* %}(*__ email __*){% /if %}
 * @desc generate route.js, multi entries in .lavas directory
 */

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const template = require('lodash.template');
const lruCache = require('lru-cache');
const utils = require('./utils');
const config = require('./config');
const isProd = process.env.NODE_ENV === 'production';

const routesTemplate = path.join(__dirname, './templates/routes.js');
const skeletonEntryTemplate = path.join(__dirname, './templates/entry-skeleton.js');

const webpack = require('webpack');
const merge = require('webpack-merge');
const clientConfig = require('./webpack.client.conf');
const serverConfig = require('./webpack.server.conf');

const HtmlWebpackPlugin = require('html-webpack-plugin');
const SkeletonWebpackPlugin = require('vue-skeleton-webpack-plugin');

class RouteManager {

    constructor(props = {}) {
        Object.assign(this, {
            targetDir: path.join(__dirname, '../.lavas'),
            skeletonsDirname: 'skeletons'
        }, props);

        this.routes = [];

        this.cache = lruCache({
            max: 1000,
            maxAge: 1000 * 60 * 15
        });
    }

    /**
     * should current request path be prerendered ?
     *
     * @param {string} path route path
     * @return {boolean}
     */
    shouldPrerender(path) {
        if (!isProd) {
            return false;
        }
        let matchedRoute = this.routes.find(route => route.pathRegExp.test(path));

        return matchedRoute && matchedRoute.prerender;
    }

    /**
     * find html according to current route path
     *
     * @param {string} path route path
     * @return {Promise}
     */
    async prerender(path) {
        let matchedRoute = this.routes.find(route => route.pathRegExp.test(path));
        if (matchedRoute && matchedRoute.htmlPath) {
            let entry = this.cache.get(path);
            if (!entry) {
                entry = await fs.readFile(matchedRoute.htmlPath, 'utf8');
                this.cache.set(path, entry);
            }
            return entry;
        }
    }

    /**
     * create an entry file for a skeleton component
     *
     * @param {string} pagename pagename
     * @param {string} skeletonPath used as import
     * @return {string} entryPath
     */
    async createEntryForSkeleton(pagename, skeletonPath) {

        // .lavas/skeletons
        let skeletonsDir = path.join(this.targetDir, this.skeletonsDirname);
        await fs.emptyDirSync(skeletonsDir);

        // eg. .lavas/skeletons/detail-entry-skeleton.js
        let entryPath = path.join(skeletonsDir, `./${pagename}-entry-skeleton.js`);

        await fs.writeFile(
            entryPath,
            template(await fs.readFile(skeletonEntryTemplate, 'utf8'))({
                skeleton: {
                    path: skeletonPath
                }
            }),
            'utf8'
        );

        return entryPath;
    }

    /**
     * create a webpack config and compile with it
     *
     */
    async compileMultiEntries() {

        // create mpa config based on client config
        let mpaConfig = merge(clientConfig);
        let skeletonEntries = {};

        // set context and clear entries
        mpaConfig.entry = {};
        mpaConfig.context = config.globals.rootDir;

        // remove vue-ssr-client plugin
        if (config.ssr.enable) {
            // TODO: what if vue-ssr-client-plugin is not the last one in plugins array?
            mpaConfig.plugins.pop();
        }

        /**
         * for each route needs prerendering, we will:
         * 1. add a html-webpack-plugin to output a relative HTML file
         * 2. create an entry if a skeleton component is provided
         */
        await Promise.all(this.routes.map(async route => {
            let {pagename, template, prerender, skeleton} = route;

            if (prerender) {

                // allow user to provide a custom HTML template
                let htmlTemplatePath = template
                    || path.join(__dirname, './templates/index.template.html');
                let htmlFilename = `${pagename}.html`;

                // save the path of HTML file which will be used in prerender searching process
                route.htmlPath = path.join(config.webpack.output.path, htmlFilename);

                mpaConfig.entry[pagename] = ['./core/entry-client.js'];

                // add html webpack plugin
                mpaConfig.plugins.push(new HtmlWebpackPlugin({
                    filename: htmlFilename,
                    template: htmlTemplatePath,
                    inject: true,
                    minify: {
                        removeComments: true,
                        collapseWhitespace: true,
                        removeAttributeQuotes: true
                    },
                    favicon: utils.assetsPath('img/icons/favicon.ico'),
                    chunksSortMode: 'dependency'
                }));

                if (skeleton) {
                    let entryPath = await this.createEntryForSkeleton(pagename, skeleton);
                    skeletonEntries[pagename] = [entryPath];
                }
            }
        }));

        if (Object.keys(skeletonEntries).length) {
            let skeletonConfig = merge(serverConfig);
            // remove vue-ssr-client plugin
            if (config.ssr.enable) {
                // TODO: what if vue-ssr-server-plugin is not the last one in plugins array?
                skeletonConfig.plugins.pop();
            }
            skeletonConfig.entry = skeletonEntries;

            // add skeleton plugin
            mpaConfig.plugins.push(new SkeletonWebpackPlugin({
                webpackConfig: skeletonConfig
            }));
        }

        if (Object.keys(mpaConfig.entry).length) {

            await new Promise((resolve, reject) => {

                // start to compile multi entries
                webpack(mpaConfig, (err, stats) => {
                    if (err) {
                        console.error(err.stack || err);
                        if (err.details) {
                            console.error(err.details);
                        }
                        reject(err);
                        return;
                    }

                    const info = stats.toJson();

                    if (stats.hasErrors()) {
                        console.error(info.errors);
                        reject(info.errors);
                        return;
                    }

                    if (stats.hasWarnings()) {
                        console.warn(info.warnings);
                    }

                    console.log('[Lavas] prerender completed.');
                    resolve();
                });
            });
        }
    }

    /**
     * output routes.js into .lavas according to /pages
     *
     */
    async autoCompileRoutes() {
        const routesConfig = config.router.routes;

        console.log('[Lavas] auto compile routes...');
        this.routes = await utils.generateRouter(path.resolve(__dirname, '../pages'));

        this.routes.forEach(route => {
            // find route in config
            let routeConfig = routesConfig.find(r => r.name === route.name);

            // mixin with config
            if (routeConfig) {
                let {
                    path: routePath,
                    lazyLoading,
                    chunkname
                } = routeConfig;

                Object.assign(route, routeConfig, {
                    path: routePath || route.path,
                    lazyLoading: lazyLoading || !!chunkname
                });
            }

            /**
             * generate hash for each route which will be used in routes.js template,
             * an underscore "_" will be added in front of each hash, because JS variables can't
             * start with numbers
             */
            route.hash = crypto.createHash('md5').update(route.name).digest('hex');

            /**
             * turn route path into regexp
             * eg. /detail/:id => /^\/detail\/[^\/]+\/?$/
             */
            route.pathRegExp = new RegExp(`^${route.path.replace(/\/:[^\/]*/g, '/[^\/]+')}\/?$`);
        });

        // write contents into .lavas/routes.js
        await fs.writeFile(
            path.join(this.targetDir, './routes.js'),
            template(await fs.readFile(routesTemplate, 'utf8'))({routes: this.routes}),
            'utf8'
        );

        console.log('[Lavas] all routes are already generated.');
    }
}

module.exports = new RouteManager();
