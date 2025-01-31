'use strict';

var _               = require('underscore');
var basicAuth       = require('basic-auth-connect');
var bodyParser      = require('body-parser');
var cookieParser    = require('cookie-parser');
var db              = require('./db');
var errorHandler    = require('errorhandler');
var express         = require('express');
var favicon         = require('serve-favicon');
var logger          = require('morgan');
var methodOverride  = require('method-override');
var mongodb         = require('mongodb');
var routes          = require('./routes');
var session         = require('express-session');
var utils           = require('./utils');

var router = function(config) {
  // appRouter configuration
  var appRouter = express.Router();
  var mongo = db(config);

  if (config.useBasicAuth) {
    appRouter.use(basicAuth(config.basicAuth.username, config.basicAuth.password));
  }

  appRouter.use(favicon(__dirname + '/../public/images/favicon.ico'));
  appRouter.use(logger('dev'));
  appRouter.use('/', express.static(__dirname + '/../public'));

  // Set request size limit
  appRouter.use(bodyParser.urlencoded({
    extended: true,
    limit:    config.site.requestSizeLimit,
  }));

  appRouter.use(cookieParser(config.site.cookieSecret));
  appRouter.use(session({
    key:                config.site.cookieKeyName,
    resave:             true,
    saveUninitialized:  true,
    secret:             config.site.sessionSecret,
  }));
  appRouter.use(methodOverride(function(req) {
    if (req.body && typeof req.body === 'object' && '_method' in req.body) {
      // look in urlencoded POST bodies and delete it
      var method = req.body._method;
      delete req.body._method;
      return method;
    }
  }));

  if (process.env.NODE_ENV === 'development') {
    appRouter.use(errorHandler());
  }

  // view helper, sets local variables used in templates
  appRouter.all('*', function(req, res, next) {
    // ensure a trailing slash on the baseHref (used as a prefix in routes and views)
    res.locals.baseHref       = req.app.mountpath + (req.app.mountpath[req.app.mountpath.length - 1] === '/' ? '' : '/');
    res.locals.databases      = mongo.databases;
    res.locals.collections    = mongo.collections;
    res.locals.gridFSBuckets  = utils.colsToGrid(mongo.collections);

    //Flash messages
    if (req.session.success) {
      res.locals.messageSuccess = req.session.success;
      delete req.session.success;
    }

    if (req.session.error) {
      res.locals.messageError = req.session.error;
      delete req.session.error;
    }

    mongo.updateDatabases(mongo.adminDb, function(databases) {
      mongo.databases       = databases;
      res.locals.databases  = mongo.databases;
      return next();
    });
  });

  // route param pre-conditions
  appRouter.param('database', function(req, res, next, id) {
    //Make sure database exists
    if (!_.include(mongo.databases, id)) {
      req.session.error = 'Database not found!';
      return res.redirect(res.locals.baseHref);
    }

    req.dbName = id;
    res.locals.dbName = id;

    if (mongo.connections[id] !== undefined) {
      req.db = mongo.connections[id];
    } else {
      mongo.connections[id] = mongo.mainConn.db(id);
      req.db = mongo.connections[id];
    }

    next();
  });

  // GridFS (db)/gridFS/(bucket)
  appRouter.param('bucket', function(req, res, next, id) {

    req.bucketName = id;
    res.locals.bucketName = id;

    mongo.connections[req.dbName].collection(id + '.files', function(err, filesConn) {
      if (err || filesConn === null) {
        req.session.error = id + '.files collection not found! Err:' + err;
        return res.redirect(res.locals.baseHref + 'db/' + req.dbName);
      }

      req.filesConn = filesConn;

      filesConn.find({}).toArray(function(err, files) {
        if (err || files === null) {
          req.session.error = id + '.files collection not found! Error:' + err;
          return res.redirect(res.locals.baseHref + 'db/' + req.dbName);
        }

        req.files = files;

        next();
      });
    });
  });

  // GridFS files
  appRouter.param('file', function(req, res, next, id) {
    req.fileID = JSON.parse(decodeURIComponent(id));
    next();
  });

  // :collection param MUST be preceded by a :database param
  appRouter.param('collection', function(req, res, next, id) {
    //Make sure collection exists
    if (!_.include(mongo.collections[req.dbName], id)) {
      req.session.error = 'Collection not found!';
      return res.redirect(res.locals.baseHref + 'db/' + req.dbName);
    }

    req.collectionName = id;
    res.locals.collectionName = id;
    res.locals.collections = mongo.collections[req.dbName];
    res.locals.gridFSBuckets = utils.colsToGrid(mongo.collections[req.dbName]);

    mongo.connections[req.dbName].collection(id, function(err, coll) {
      if (err || coll === null) {
        req.session.error = 'Collection not found!';
        return res.redirect(res.locals.baseHref + 'db/' + req.dbName);
      }

      req.collection = coll;

      next();
    });
  });

  // :document param MUST be preceded by a :collection param
  appRouter.param('document', function(req, res, next, id) {
    if (id === 'undefined' || id === undefined) {
      req.session.error = 'Document lacks an _id!';
      return res.redirect(res.locals.baseHref + 'db/' + req.dbName + '/' + req.collectionName);
    }

    id = JSON.parse(decodeURIComponent(id));
    var obj_id;

    // Attempt to create ObjectID from passed 'id'
    try {
      obj_id = new mongodb.ObjectID.createFromHexString(id);
    } catch (err) {
    }

    // If an ObjectID was correctly created from passed id param, try getting the ObjID first else falling back to try getting the string id
    // If not valid ObjectID created, try getting string id

    if (obj_id) {
      // passed id has successfully been turned into a valid ObjectID
      req.collection.findOne({_id: obj_id}, function(err, doc) {
        if (err) {
          req.session.error = 'Error: ' + err;
          return res.redirect(res.locals.baseHref + 'db/' + req.dbName + '/' + req.collectionName);
        }

        if (doc === null) {
          // No document found with obj_id, try again with straight id
          req.collection.findOne({_id: id }, function(err, doc) {
            if (err) {
              req.session.error = 'Error: ' + err;
              return res.redirect(res.locals.baseHref + 'db/' + req.dbName + '/' + req.collectionName);
            }

            if (doc === null) {
              req.session.error = 'Document not found!';
              return res.redirect(res.locals.baseHref + 'db/' + req.dbName + '/' + req.collectionName);
            }

            // Document found - send it back
            req.document = doc;
            res.locals.document = doc;

            next();
          });
        } else {
          // Document found - send it back
          req.document = doc;
          res.locals.document = doc;

          next();
        }

      });
    } else {
      // Passed id was NOT a valid ObjectID
      req.collection.findOne({_id: id}, function(err, doc) {
        if (err) {
          req.session.error = 'Error: ' + err;
          return res.redirect(res.locals.baseHref + 'db/' + req.dbName + '/' + req.collectionName);
        }

        if (doc === null) {
          req.session.error = 'Document not found!';
          return res.redirect(res.locals.baseHref + 'db/' + req.dbName + '/' + req.collectionName);
        }

        req.document = doc;
        res.locals.document = doc;

        next();
      });
    }
  });

  // get individual property - for async loading of big documents
  // (db)/(collection)/(document)/(prop)
  appRouter.param('prop', function(req, res, next, prop) {
    req.prop = req.document[prop];
    next();
  });

  // mongodb mongoMiddleware
  var mongoMiddleware = function(req, res, next) {
    req.mainConn      = mongo.mainConn;
    req.adminDb       = mongo.adminDb;
    req.databases     = mongo.databases; //List of database names
    req.collections   = mongo.collections; //List of collection names in all databases
    req.gridFSBuckets = utils.colsToGrid(mongo.collections);

    //Allow page handlers to request an update for collection list
    req.updateCollections = mongo.updateCollections;

    next();
  };

  // routes
  appRouter.get('/', mongoMiddleware, routes(config).index);
  appRouter.post('/', mongoMiddleware, routes(config).addDatabase);
  appRouter.delete('/:database', mongoMiddleware, routes(config).deleteDatabase);
  appRouter.get('/db/:database', mongoMiddleware, routes(config).viewDatabase);

  appRouter.post('/checkValid', mongoMiddleware, routes(config).checkValid);

  appRouter.get('/db/:database/compact/:collection', mongoMiddleware, routes(config).compactCollection);
  appRouter.get('/db/:database/expArr/:collection', mongoMiddleware, routes(config).exportColArray);
  appRouter.get('/db/:database/export/:collection', mongoMiddleware, routes(config).exportCollection);
  appRouter.get('/db/:database/updateCollections', mongoMiddleware, routes(config).updateCollections);

  appRouter.get('/db/:database/gridFS/:bucket', mongoMiddleware, routes(config).viewBucket);
  appRouter.post('/db/:database/gridFS/:bucket', mongoMiddleware, routes(config).addFile);
  appRouter.get('/db/:database/gridFS/:bucket/:file', mongoMiddleware, routes(config).getFile);
  appRouter.delete('/db/:database/gridFS/:bucket/:file', mongoMiddleware, routes(config).deleteFile);

  appRouter.post('/db/:database/:collection', mongoMiddleware, routes(config).addDocument);
  appRouter.get('/db/:database/:collection/:document', mongoMiddleware, routes(config).viewDocument);
  appRouter.put('/db/:database/:collection/:document', mongoMiddleware, routes(config).updateDocument);
  appRouter.delete('/db/:database/:collection/:document', mongoMiddleware, routes(config).deleteDocument);

  appRouter.get('/db/:database/:collection/:document/:prop', mongoMiddleware, routes(config).getProperty);

  appRouter.get('/db/:database/:collection', mongoMiddleware, routes(config).viewCollection);
  appRouter.put('/db/:database/:collection', mongoMiddleware, routes(config).renameCollection);
  appRouter.delete('/db/:database/:collection', mongoMiddleware, routes(config).deleteCollection);
  appRouter.post('/db/:database', mongoMiddleware, routes(config).addCollection);

  return appRouter;
};

module.exports = router;
