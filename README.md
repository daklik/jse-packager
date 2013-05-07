JSE-packager
============

Runtime packager for JSE classes.
Can serve packed classes through classical HTTP GET, XHR and WebSockets.
To be used alongside JSE (https://github.com/daklik/jse).

Usage : node src/jse-packager.js --port 8080 "/directory/to/your/jse/classes" "/directory/to/your/other/jse/classes"

Options :
    -v              Verbose
    --port number   Specify a port to listen (default 8090)
    
