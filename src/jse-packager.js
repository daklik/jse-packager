var express = require("express"),
    ws = require("ws"),
    ugly = require("uglify-js"),
    http = require("http"),
    fs = require("fs"),
    hash = require("crypto").Hash,
    argv = require("optimist").argv,
    util = require('util');

var app = express();
app.use(express.compress());
app.use(app.router);

var server = http.createServer(app);
var wss = new ws.Server({server: server});

var cache = {};
var verbose = argv.v;
var importAliases = argv.import;
var useVersioning = argv.versioning;

/*
    Loading JS classes into memory
 */
if (!useVersioning) {
    /*
        If not using versioning, check sources directly from subdirectories
     */
    for (var i=0; i < argv._.length; i++) {
        checkDirectory(argv._[i]);
    }
} else {
    /*
        If using versioning, will consider any first level subdirectory as a version
     */
    for (var i=0; i < argv._.length; i++) {
        var dir = argv._[i];
        var files = fs.readdirSync(dir);
        if (verbose) {
            console.log("Checking directory for versions: " + dir + " (" + files.length + " directories or files to check)");
        }
        for (var j=0; j < files.length; j++) {
            if (files[j].indexOf(".") === -1 || files[j].indexOf(".") > 0) {
                var stat = fs.statSync(dir + "/" + files[j]);
                if (stat.isDirectory()) {
                    if (verbose) {
                        console.log("Caching new version: " + files[j]);
                    }
                    cache[files[j]] = {};
                    checkDirectory(dir + "/" + files[j], files[j]);
                }
            }
        }
        //ToDO add Watch on directory for version adding and deleting
    }
}

function checkDirectory(dir, cacheVersion) {
    var files = fs.readdirSync(dir);
    for (var i=0; i < files.length; i++) {
        if (files[i].indexOf(".") === -1 || files[i].indexOf(".") > 0) {
            checkStats(dir + "/" + files[i], cacheVersion);
        }
    }
}
function checkStats(path, cacheVersion) {
    var stat = fs.statSync(path);
    if (stat.isDirectory()) {
        checkDirectory(path, cacheVersion);
    } else if (stat.isFile()) {
        loadFile(path, cacheVersion);
    }
}
function loadFile(path, cacheVersion) {
    var data = fs.readFileSync(path, "utf-8");
    var result = data;
    //Todo Replace import aliases before setting content in cache(performance issue)
    var jsePackage = extractJsePackage(data);
    if (jsePackage !== null) {
        result = ugly.minify(data, {fromString: true});
        var h = new hash("md5");
        h.update(result.code);
        if (verbose) {
            console.log("Caching package: " + jsePackage + " (uglified " + result.code.length + "/" + data.length + ")");
        }
        var finalResult = [jsePackage, result.code + "JSE.extend(" + jsePackage + ", JSE.Object);", h.digest("hex"), path, checkForImports(result.code)];
        if (cacheVersion) {
            cache[cacheVersion][jsePackage] = finalResult;
        } else {
            cache[jsePackage] = finalResult;
        }
    }
}
function extractJsePackage(data) {
    var packIndex = data.indexOf("JSEPackage(");
    if (packIndex !== -1) {
        return data.substring(packIndex + 12, data.indexOf(")", packIndex) - 1);
    }
    return null;
}


/**
 * Starting the server
 * @param port  default 8090
 */
startServer(argv.port || 8090);

function startServer(port) {

    server.listen(port);
    /**
     * WebSocket
     */
    wss.on("connection", function(socket) {
        socket.on("message", function(data) {
            data = JSON.parse(data);
            if (cache[data.namespace]) {
                socket.send(JSON.stringify({
                    "event" : "importResponse",
                    "namespace" : data.namespace,
                    "packages" : loadFileAndImports(data.namespace, [], data.cache, [])
                }));
            }
        });
        socket.on("cacheCheckRequest", function(data) {
            socket.send({
               event : "cacheCheckResponse",
               packages : [
               ]
            });
        });
    });
    /**
     *  List of cached elements
     */
    app.get("/getCache", function(req, res) {
        res.send(200, cache);
    });
    /**
     *  Service Monitoring
     */
    app.get("/isUp", function(req, res) {
        res.send(200, "OK");
    });
    /**
     *  Memory usage
     */
    app.get("/memoryUsage", function(req, res) {
        res.send(200, util.inspect(process.memoryUsage()));
    });
    /**
     * Check type of request for service
     */
    app.get("/*", function(req, res) {

        var result = loadFileAndImports(getNamespaceFromURL(req.url), [], addDependenciesToQuery(req.query), []);
        result.sort(sortNamespaces);
        if (req.xhr) {
            //Service as XHR, packaged library
            res.send(buildFinalResultLibrary(result, addDependenciesToQuery(req.query)));
        }
        else if (req.query.callback) {
            //Service as JSONP response, object oriented
            res.jsonp(result);
        } else {
            //Default Service as Packaged JS Library
            res.send(buildFinalResultLibrary(result, addDependenciesToQuery(req.query)));
        }
    });
}
function addDependenciesToQuery(query) {
    for (var item in query) {
        if (cache[item]) {
            var dependencies = cache[item][4];
            for (var i=0; i < dependencies.length; i++) {
                if (!query[dependencies[i]]) {
                    query[dependencies[i]] = cache[dependencies[i]][2];
                }
            }
        }
    }
    return query;
}
function buildFinalResultLibrary(result, query, ns, version) {
    function removeImportsNotInClientCache(str, qu) {
        var i;
        if (importAliases) {
            var aliases = importAliases.split(",");
            for (i=0; i < aliases.length; i++) {
                str = str.replace(new RegExp(aliases[i], "g"), "JSEImport");
            }
        }

        if (str.indexOf("JSEImport(\"") === -1) {
            return str;
        }
        var imports = str.split("JSEImport(\"");
        var remaining = imports[0];

        for (i=1; i < imports.length; i++) {
            //var ns = imports[i].substring(0, imports[i].indexOf("\""));
            if (qu[ns]) {
                remaining += "JSEImport(\"" + imports[i];
            } else {
                remaining += imports[i].substr(imports[i].indexOf(")") + 2);

            }
        }


        return remaining;
    }
    var finalResult = "";
    var namespacesLoaded = "JSE.Cache.addFromLib([";
    for (var i=0; i < result.length; i++) {
        finalResult += removeImportsNotInClientCache(result[i][1], query, result[i][0]);
        namespacesLoaded += ((i > 0) ? "," : "") + "['" + result[i][0] + "','" +  result[i][2] + "']";
    }
    namespacesLoaded += "]);";
    finalResult = namespacesLoaded + finalResult + ";JSE.Cache.fixConflicts();";
    return finalResult;
}
function getNamespaceFromURL(url) {
    if (!useVersioning) {
        return url.substring(1, url.lastIndexOf("/")).replace(/\//g, ".");
    } else {
        return url.substring(url.indexOf("/", 1) + 1, url.lastIndexOf("/")).replace(/\//g, ".");
    }
}
function checkForImports(file) {
    //Check for dependencies and return them in an Array of namespaces
    var imports = [], i;
    if (importAliases) {
        var aliases = importAliases.split(",");
        for (i=0; i < aliases.length; i++) {
            file = file.replace(new RegExp(aliases[i], "g"), "JSEImport");
        }
    }
    if (file.indexOf("JSEImport(\"") === -1) {
        return imports;
    }
    var files = file.split("JSEImport(\"");
    for (i=1; i < files.length; i++) {
        imports.push(files[i].substring(0, files[i].indexOf("\"")));
    }
    return imports;
}
function loadFileAndImports(namespace, result, clientCache, current) {
    function arrayIndexOf(source, match) {
        for (var i = 0; i < source.length; i++) {
            if (source[i] === match) {
                return i;
            }
        }
        return -1;
    }
    //Check if namespace already in current response
    if (arrayIndexOf(current, namespace) !== -1) {
        return;
    }
    //Load either from file or from Service's cache
    var content = cache[namespace];
    if (content) {
        //Check the version on client's side and on Service's side
        if (clientCache && clientCache[namespace] && clientCache[namespace] === content[2]) {
            //Namespace already in client's local cache
            return;
        }
        result.push(content);
        current.push(namespace);
        //Check dependencies to add to result and load them
        var a = content[4];
        for (var i=0; i < a.length; i++)
        {
            loadFileAndImports(a[i], result, clientCache, current);
        }
    }
    return result;
}
function sortNamespaces(a,b)
{
    //Sort namespaces by alpha
    if (a[0] < b[0]) {
        return -1;
    }
    if (a[0] > b[0]) {
        return 1;
    }
    return 0;
}




