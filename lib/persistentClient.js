"use strict"

//module initialization
module.exports = function (logClass) {

  //Constants
  const MAX_CONECTIONS_RETRIES = 100;
  const DELAY_CONNECTION_RETRY = 1000;  //Actual delay is connectionRetries * DELAY_CONNECTION_RETRY
  const CONNECTION_TIMEOUT     = 10000; //Time to wait for connection before failing a connection promise

  //Includes
  const Client                = require('castv2-client').Client;
  const EventEmitter          = require('events').EventEmitter;

  let log = logClass ? logClass : require("./dummyLogClass")("PersistentClient");

  class PersistentClient extends EventEmitter {

    constructor(device) {

      super();
      let that = this;

      that._host  = device.host;
      that._name  = device.name;
      that._port  = device.port;

      //List of events triggered by PersistentClient:
      that.EVENT_CONNECTED    = "clientConnected";
      that.EVENT_DISCONNECTED = "clientDisconnected";
      that.EVENT_STATUS       = "clientStatus";

      that._connectClient();

    };

    /*
     * Public PersistentClient methods
     */

    //update device
    updateDevice (device) {

      let that = this;
      let needReconnect = false;
      if (that._client  === undefined) {
        log.info("Received keep alive for disconnected device %s", device.name);
        needReconnect = true;
      }
      if (that._host != device.host) {
        log.info("New URL for device %s: %s", device.name, device.host);
        that._host  = device.host;
        needReconnect = true;
      }
      if (that._name != device.name) {
        log.info("New name for device: %s", device.name);
        that._name  = device.name;
        needReconnect = true;
      }
      if (that._port != device.port) {
        log.info("New port for device %s: %s", device.name, device.port);
        that._port  = device.port;
        needReconnect = true;
      }
      if (needReconnect) {
        log.info("Reconnecting %s to %s:%s", device.name, device.host, device.port);
        that.close();
        that._connectClient();
      } else {
        log.debug("No need to reconnected for %s", device.name);
      }
    }

    //join player
    joinPromise (session, application) {
      let that = this;

      return that._getConnectedClientPromise()
      .then (function (client) {return that._joinPromise (client, session, application);});
    }

    //launch player
    launchPromise (application) {
      let that = this;

      return that._getConnectedClientPromise()
      .then (function (client) {return that._launchPromise (client, application);});
    }

    close () {
      this._close();
    }

    //setVolume
    setVolumePromise (volume) {
      let that = this;

      try{
        if (volume === that.getVolume()) {
          log.info("%s - setting volume to same value %s - ignored", that._name, volume);
          return Promise.resolve(volume);
        }
      } catch (e) {
        log.info(`Failed getVolume in castv2-player persistentClient ${e}`)
      }

      return that._getConnectedClientPromise()
      .then (function (client) {return that._setVolumePromise (client, volume);});
    }

    //get volume
    getVolumePromise () {
      let that = this;

      return that._getConnectedClientPromise()
      .then (function (client) {return that._getVolumePromise (client);});
    }

    //Mute
    mutePromise (volume) {
      let that = this;

      return that._getConnectedClientPromise()
      .then (function (client) {return that._mutePromise (client, true);});
    }

    //Unmute
    unmutePromise (volume) {
      let that = this;

      return that._getConnectedClientPromise()
      .then (function (client) {return that._mutePromise (client, false);});
    }

    //stop Promise
    stopPromise(){
      let that = this;

      return that._getConnectedClientPromise()
      .then (function (client) {return that._stopPromise (client);});
    }

    //get cached status
    getStatus(){
      let that = this;
      return that._status;
    }
    getPreviousStatus(){
      let that = this;
      return that._previousStatus;
    }
    getVolume(){
      let that = this;
      if (that.getStatus()) {
        return that._parseVolume(that.getStatus().volume);
      } else {
        return 0;
      }
    }
    getIsMuted(){
      let that = this;
      if (that.getStatus()) {
       return that.getStatus().volume.muted;
      } else {
        return false;
      }
    }

    /*
     * Private methods
     */

    _close () {
      let that = this;

      if (that._connecting_client) {
        that._connecting_client.removeAllListeners('error');
        try {
          that._connecting_client.close();
        } catch (e) {log.debug("%s - Error trying to close pending connection (expected) - %s", that._name, e);};
        delete that._connecting_client;
        that._connecting_client = undefined;
      }

      //If connection opened try to close it
      if (that._client) {
        //Try to close connection
        try
        {
          //We do not want to retry on the close or error
          that._client.removeListener('close', that._connectClient.bind(that));
          that._client.removeAllListeners('error');

          //Register dummy handler for any following error getting caught
          // that._client.on("error", function(err){
          //   log.warn(that._name + " - Client error (DUP): " + err.stack);
          // });

          //Close clientConnection
          //that._client.stop();
          that._client.client.socket.destroy();
          that._client.close();


        } catch (e) {log.error("%s - Error disconnecting - %s", that._name, e);};

        //No status available (but we kee the previousStatus)
        that._status = undefined;

        //Emit clientDisconnect event
        that.emit(that.EVENT_DISCONNECTED);

        delete that._client;
        that._client = undefined;
      }

      //If we were trying to connect -> abort;
      if (that._clientTimeout)
        clearTimeout(that._clientTimeout);
    }

    _connectClient () {

      let that = this;

      if (that._connecting_client || that._client) {
        log.debug("%s - No need to connect. _connecting_client: %s, _client: %s", that._name, that._connecting_client, that._client);
        return;
      }

      //Try to launch client - with a threshold
      let connectionRetries = 0;
      let launchRetry = function(){

        that._clientTimeout = undefined;

        connectionRetries++;
        if (connectionRetries <= MAX_CONECTIONS_RETRIES) {

          //Try to connect
          that._connecting_client = new Client();

          that._connecting_client.connect({host:that._host, port:that._port}, function(){

            //Sucesfully connected to Chromecast
            log.info("%s - Connected client", that._name);

            //Set retries to 0 for next try
            connectionRetries = 0;

            //Connection stable
            that._client = that._connecting_client;
            that._connecting_client = undefined;

            //If connection closes afterwards then re-open it again
            that._client.client.once("close", function(){
              that._close();
              that._connectClient();
            });

            //Register for status updates
            that._client.on("status", that._updateStatus.bind(that));

            //Trigger an statusUpdate
            that._client.getStatus(function(err,status){
              that._updateStatus(status);
            });

            //Emit clientConnect event
            that.emit(that.EVENT_CONNECTED);

          }); //END - launch

          //Register for errors
          that._connecting_client.once("error", function(err){
            log.warn(that._name + " - Client error: " + err.stack);

            //Register dummy handler for any following error getting caught
            // client.on("error", function(err){
            //   log.warn(that._name + " - Client error (DUP): " + err.stack);
            // });

            that.close();

            //Try to re-connect after some time
            that._clientTimeout = setTimeout(
              function () {
                launchRetry();
              }, connectionRetries * DELAY_CONNECTION_RETRY);
          });

        } else {

          //No retries left
          log.warn("%s - Max amount of reconnects reached - stay offline", that._name);

        } //END - max retry check

      } //END - launchRetry function

      launchRetry();
    }

    _updateStatus (status) {
      let that = this;
      /*
       * Example for Chromecast audio (plex)
       * {"applications":[{"appId":"9AC194DC",
       *                   "displayName":"Plex",
       *                   "namespaces":[{"name":"urn:x-cast:com.google.cast.media"},
       *                                 {"name":"urn:x-cast:plex"}],
       *                   "sessionId":"EB5AB303-F876-48E7-BF4A-5653A00031EA",
       *                   "statusText":"Plex",
       *                   "transportId":"web-283"}],
       *  "volume":{"level":0.007843137718737125,
       *            "muted":false}}
       *
       *
       * Example for video
       * {"applications":[{"appId":"E8C28D3C",
       *                   "displayName":"Backdrop",
       *                   "namespaces":[{"name":"urn:x-cast:com.google.cast.sse"}],
       *                   "sessionId":"89967E57-7F4E-4449-A5F0-62A2F4C7AB73",
       *                   "statusText":"","transportId":"web-58"}],
       *  "isActiveInput":false,
       *  "isStandBy":false,
       *  "volume":{"level":1,
       *            "muted":false}}
       *
       */

      //log.debug(this._name + ' currentApplicationObject ' + JSON.stringify(status));

      //Cache Player channel status
      that._previousStatus = that._status ? JSON.parse(JSON.stringify(that._status)): undefined; //Deep clone
      that._status = that._status ? Object.assign(that._status, status) : status;

      that.emit(that.EVENT_STATUS, that._status, that._previousStatus);
    }

    _getConnectedClientPromise () {
      let that = this;

      if (that._client)
        return Promise.resolve(that._client);

      that._connectClient();

      log.warn("%s - Waiting up to %s seconds for connection to chromecast", that._name, CONNECTION_TIMEOUT/1000);

      return new Promise(function(resolve, reject) {
        //Set timeout to 10 seconds
        let timeout = setTimeout(reject.bind (Error("Could not connect after 10 seconds")), CONNECTION_TIMEOUT);
        that.once(that.EVENT_STATUS, function() {
          //If we receive client status then we are connected
          clearTimeout(timeout);
          resolve(that._client);
          log.warn("%s - Reconnected -> continue", that._name);
        });
      });
    }

    _joinPromise (client, session, application) {
      return new Promise (function (resolve, reject) {
        client.join(session, application, function (err, p) {
          if (err)
            reject(err);
          else
            resolve(p);
        });
      });
    }

    _launchPromise (client, application) {
      return new Promise (function (resolve, reject) {
        client.launch(application, function (err, p) {
          if (err)
            reject(err);
          else
            resolve(p);
        });
      });
    }

    //Parse volume
    _parseVolume(volumenObject) {
      return Math.round(volumenObject.level*100)
    }

    //setVolume
    _setVolumePromise (client, volume) {
      let that = this;
      return new Promise (function (resolve, reject) {
        client.setVolume({level: (volume / 100)}, function (err, volumenObject) {
          if (err)
            reject(err);
          else {
            log.info("%s - set volume to %s", that._name, that._parseVolume(volumenObject));
            resolve(that._parseVolume(volumenObject));
          }
        });
      });
    }

    //get volume
    _getVolumePromise (client) {
      let that = this;
      return new Promise (function (resolve, reject) {
        client.getVolume(function (err, volumenObject) {
          if (err)
            reject(err);
          else {
            resolve(that._parseVolume(volumenObject));
            log.info("%s - got volume: %s", that._name, that._parseVolume(volumenObject));
          }
        });
      });
    }

    //Mute/Unmute
    _mutePromise (client, mute) {
      let that = this;
      return new Promise (function (resolve, reject) {
        client.setVolume({muted: mute}, function (err, volumenObject) {
          if (err)
            reject(err);
          else {
            log.info("%s - muted to %s", that._name, volumenObject.muted);
            resolve(that._parseVolume(volumenObject));
          }
        });
      });
    }

    //stop
    _stopPromise (client) {
      let that = this;

      return new Promise (function (resolve, reject) {
        log.info("%s - Trying to stop client", that._name);
          if (that._status.applications && that._status.applications.length > 0) {
            client.receiver.stop(that._status.applications[0].sessionId, function() {
              log.info("%s - stopped client", that._name);
              //Triger reconnection
              that.close();
              that._connectClient ();
              resolve();
            });
          } else
            resolve();
      });
    }

  }

  //Export PersistentClient class
  return PersistentClient;
}
