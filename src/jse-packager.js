var express = require("express"),
    ws = require("ws"),
    ugly = require("uglify-js"),
    http = require("http"),
    fs = require("fs"),
    hash = require("crypto").Hash,
    argv = require("optimist").argv;

var app = express();
app.use(express.compress());


var server = http.createServer(app);
var wss = new ws.Server({server: server});

for (var i=0; i < argv._.length; i++) {
    checkDirectory(argv._[i]);
}
startServer(argv.port || 8090);

var verbose = argv.v;

/*
    Loading JS classes into memory
 */
var cache = {};
function checkDirectory(dir) {
    //console.log("Checking directory: " + dir);
    fs.readdir(dir, function(error, files) {
        for (var i=0; i < files.length; i++) {
            if (files[i].indexOf(".") === -1 || files[i].indexOf(".") > 0) {
                checkStats(dir + "/" + files[i]);
            }
        }
    });
}
function checkStats(path) {
    fs.stat(path, function(error, stat) {
        if (stat.isDirectory()) {
            checkDirectory(path);
        } else if (stat.isFile()) {
            loadFile(path);
        }
    });
}
function loadFile(path) {
    //console.log("Caching file: " + path);
    fs.readFile(path, "utf-8", function(err, data) {
        if (err) {
            return;
        }
        var result = data;

        var jsePackage = extractJsePackage(data);
        if (jsePackage !== null) {
            result = ugly.minify(data, {fromString: true});
            var h = new hash("md5");
            h.update(result.code);
            if (verbose) {
                console.log("Caching package: " + jsePackage + " (uglified " + result.code.length + "/" + data.length + ")");
            }
            var finalResult = [jsePackage, result.code + "JSE.extend(" + jsePackage + ", JSE.Object);", h.digest("hex"), path];
            cache[jsePackage] = finalResult;
        }
    });
}
function extractJsePackage(data) {
    var packIndex = data.indexOf("JSEPackage");
    if (packIndex !== -1) {
        return data.substring(packIndex + 12, data.indexOf(")", packIndex) - 1);
    }
    return null;
}
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
     * Check type of request
     */
    app.use(function(req, res) {
        var result = loadFileAndImports(getNamespaceFromURL(req.url), [], req.query, []);
        result.sort(sortNamespaces);
        if (req.xhr) {
            //Service as XHR, packaged library
            res.send(buildFinalResultLibrary(result, req.query));
        }
        else if (req.query.callback) {
            //Service as JSONP response, object oriented
            res.jsonp(result);
        } else {
            //Default Service as Packaged JS Library
            res.send(buildFinalResultLibrary(result, req.query));
        }
    });
}
function buildFinalResultLibrary(result, query, ns, version) {
    function removeImportsNotInClientCache(str, qu) {
        str = str.replace(/JSEImportApi/g, "JSEImport").replace(/JSEImportTrad/g, "JSEImport");
        if (str.indexOf("JSEImport(\"") === -1) {
            return str;
        }
        var imports = str.split("JSEImport(\"");
        var remaining = imports[0];

        for (var i=1; i < imports.length; i++) {
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
    var namespacesLoaded = "JSE.Cache.addFromLib([0";
    for (var i=0; i < result.length; i++) {
        finalResult += removeImportsNotInClientCache(result[i][1], query, result[i][0]);
        namespacesLoaded += "," + "['" + result[i][0] + "','" +  result[i][2] + "']";
    }
    namespacesLoaded += "]);";
    finalResult = namespacesLoaded + finalResult + ";JSE.Cache.fixConflicts();";
    return finalResult;
}
function getNamespaceFromURL(url) {
    return url.substring(1, url.lastIndexOf("/")).replace(/\//g, ".");
}
function checkForImports(file) {
    //Check for dependancies and return them in an Array of namespaces
    var imports = [];
    file = file.replace(/JSEImportApi/g, "JSEImport").replace(/JSEImportTrad/g, "JSEImport");
    if (file.indexOf("JSEImport(\"") === -1) {
        return imports;
    }
    var files = file.split("JSEImport(\"");
    for (var i=1; i < files.length; i++) {
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
        if (clientCache && clientCache[namespace] && clientCache[namespace] === cache[namespace][2]) {
            //Namespace already in client's local cache
            return;
        }
        result.push(content);
        current.push(namespace);
        //Check dependencies to add to result and load them
        var a = checkForImports(content[1]);
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




