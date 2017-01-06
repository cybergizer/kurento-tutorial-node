/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var path = require('path');
var url = require('url');
var express = require('express');
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
var fs    = require('fs');
var https = require('https');

var argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'https://localhost:8443/',
        ws_uri: 'ws://localhost:8888/kurento'
    }
});

var options =
{
  key:  fs.readFileSync('keys/server.key'),
  cert: fs.readFileSync('keys/server.crt')
};

var app = express();

var recorder = null;

/*
 * Definition of global variables.
 */
var idCounter = 0;
var candidatesQueue = {};
var kurentoClient = null;
var presenter = null;
var viewers = [];
var listeners = [];
var noPresenterMessage = 'No active presenter. Try again later...';

/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server : server,
    path : '/one2many'
});

function nextUniqueId() {
	idCounter++;
	return idCounter.toString();
}

function play(sessionId, message, ws) {

  getKurentoClient(function(error, kurentoClient) {
    if (error) return console.log("ERROR 1: Could not find media server at address" + ws_uri + ". Exiting with error " + error);

    // Create pipline
    console.log('Creating MediaPipline');
    kurentoClient.create('MediaPipeline', function(error, pipeline) {
      if (error) return console.log("ERROR 2: " + error);

      // Create player
      console.log('Creating PlayerEndpoint');

      // pipeline.create('PlayerEndpoint', {uri: "http://files.kurento.org/video/format/sintel.webm"}, function(error, playerEndpoint) {
      console.log("WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWw", "file:///tmp/records/"+message.fileName+".webm");
      pipeline.create('PlayerEndpoint', {uri: "file:///tmp/records/"+message.fileName+".webm"}, function(error, playerEndpoint) {
      // pipeline.create('PlayerEndpoint', {uri: "file:///tmp/records/file08580415751031487.webm"}, function(error, playerEndpoint) {
        if (error) return console.log("ERROR 3: " + error);

        playerEndpoint.on('EndOfStream', function() {
          console.log('END OF STREAM');
          pipeline.release();
        });

        console.log('Now Playing');
        playerEndpoint.play(function(error) {
          if (error) return console.log("ERROR 4: " + error);

          // Create WebRtc
          console.log('Creating WebRTCEndpoint');
          pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
            if (error) return console.log("ERROR 5: " + error);

            listeners[sessionId] = {
              "webRtcEndpoint" : webRtcEndpoint,
              "ws" : ws
            }

            if (candidatesQueue[sessionId]) {

                while(candidatesQueue[sessionId].length) {
                    var candidate = candidatesQueue[sessionId].shift();
                    webRtcEndpoint.addIceCandidate(candidate);
                }
            }

            webRtcEndpoint.on('OnIceCandidate', function(event) {
                var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                ws.send(JSON.stringify({
                    id : 'iceCandidate',
                    candidate : candidate
                }));
            });

            console.log('Processing SDP offer');
            webRtcEndpoint.processOffer(message.sdpOffer, function(error, sdpAnswer) {
              if (error) return console.log("ERROR 6: " + error);

              console.log('Connecting to endpoint');
              playerEndpoint.connect(webRtcEndpoint, function(error) {
                if (error) return console.log("ERROR 7: " + error);

                console.log('Connected!');
                ws.send(JSON.stringify({
                  id : 'play',
                  response : 'accepted',
                  sdpAnswer : sdpAnswer
                }));
              });
            });

            webRtcEndpoint.gatherCandidates(function(error) {
                if (error) {
                    return callback(error);
                }
            });
          });
        });
      });
    });
  });
}

function start(session, fileName) {
  getKurentoClient(function(error, kurentoClient) {
    kurentoClient.create('MediaPipeline', function(error, pipeline) {
      pipeline.create('WebRtcEndpoint', function(error, webRtcEndpointSource) {
        pipeline.create('RecorderEndpoint',
          {
            uri: "file:///tmp/records/"+fileName+".webm",
            mediaProfile:'WEBM_AUDIO_ONLY'
          }, function(error, recorderEndpointA) {
             mediaType = 'AUDIO';
             webRtcEndpointSource.connect(recorderEndpointA, mediaType, function (err) {
                 recorderEndpointA.record();
                 console.log("recording started ...");
             });
        });
      });
    });
  });
}

/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws) {

	var sessionId = nextUniqueId();
	console.log('Connection received with sessionId ' + sessionId);

    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
        case 'presenter':
			startPresenter(sessionId, ws, message.sdpOffer, message.fileName, function(error, sdpAnswer) {
				if (error) {
					return ws.send(JSON.stringify({
						id : 'presenterResponse',
						response : 'rejected',
						message : error
					}));
				}
				ws.send(JSON.stringify({
					id : 'presenterResponse',
					response : 'accepted',
					sdpAnswer : sdpAnswer
				}));
			});
			break;

        case 'viewer':
			startViewer(sessionId, ws, message.sdpOffer, function(error, sdpAnswer) {
				if (error) {
					return ws.send(JSON.stringify({
						id : 'viewerResponse',
						response : 'rejected',
						message : error
					}));
				}

				ws.send(JSON.stringify({
					id : 'viewerResponse',
					response : 'accepted',
					sdpAnswer : sdpAnswer
				}));
			});
			break;

        case 'stop':
            stop(sessionId);
            break;

        case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;

        case 'start':
            start(sessionId, message['fileName']);
            break;

        case 'play':
            play(sessionId, message, ws);
            break;

        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + JSON.stringify(message)
            }));
            break;
        }
    });
});

/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            console.log("Could not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function startPresenter(sessionId, ws, sdpOffer, fileName, callback) {
	clearCandidatesQueue(sessionId);

	if (presenter !== null) {
		stop(sessionId);
		return callback("Another user is currently acting as presenter. Try again later ...");
	}

	presenter = {
		id : sessionId,
		pipeline : null,
		webRtcEndpoint : null
	}

	getKurentoClient(function(error, kurentoClient) {
		if (error) {
			stop(sessionId);
			return callback(error);
		}

		if (presenter === null) {
			stop(sessionId);
			return callback(noPresenterMessage);
		}

		kurentoClient.create('MediaPipeline', function(error, pipeline) {
			if (error) {
				stop(sessionId);
				return callback(error);
			}

			if (presenter === null) {
				stop(sessionId);
				return callback(noPresenterMessage);
			}

			presenter.pipeline = pipeline;

			pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
				if (error) {
					stop(sessionId);
					return callback(error);
				}

				if (presenter === null) {
					stop(sessionId);
					return callback(noPresenterMessage);
				}

				presenter.webRtcEndpoint = webRtcEndpoint;

                if (candidatesQueue[sessionId]) {
                    while(candidatesQueue[sessionId].length) {
                        var candidate = candidatesQueue[sessionId].shift();
                        webRtcEndpoint.addIceCandidate(candidate);
                    }
                }

                webRtcEndpoint.on('OnIceCandidate', function(event) {
                    var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                    ws.send(JSON.stringify({
                        id : 'iceCandidate',
                        candidate : candidate
                    }));
                });

				webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
					if (error) {
						stop(sessionId);
						return callback(error);
					}

					if (presenter === null) {
						stop(sessionId);
						return callback(noPresenterMessage);
					}

					callback(null, sdpAnswer);
				});

        pipeline.create('RecorderEndpoint',
          {
            uri: "file:///tmp/records/" + fileName + ".webm",
            mediaProfile:'WEBM_AUDIO_ONLY'
          }, function(error, recorderEndpointA) {
             mediaType = 'AUDIO';
             webRtcEndpoint.connect(recorderEndpointA, mediaType, function (err) {
                 recorderEndpointA.record();
                 recorder = recorderEndpointA;
                 console.log("recording started ...");
             });
        });

                webRtcEndpoint.gatherCandidates(function(error) {
                    if (error) {
                        stop(sessionId);
                        return callback(error);
                    }
                });
            });
        });
	});
}

function startViewer(sessionId, ws, sdpOffer, callback) {
	clearCandidatesQueue(sessionId);

	if (presenter === null) {
		stop(sessionId);
		return callback(noPresenterMessage);
	}

	presenter.pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
		if (error) {
			stop(sessionId);
			return callback(error);
		}
		viewers[sessionId] = {
			"webRtcEndpoint" : webRtcEndpoint,
			"ws" : ws
		}

		if (presenter === null) {
			stop(sessionId);
			return callback(noPresenterMessage);
		}

		if (candidatesQueue[sessionId]) {
			while(candidatesQueue[sessionId].length) {
				var candidate = candidatesQueue[sessionId].shift();
				webRtcEndpoint.addIceCandidate(candidate);
			}
		}

        webRtcEndpoint.on('OnIceCandidate', function(event) {
            var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
            ws.send(JSON.stringify({
                id : 'iceCandidate',
                candidate : candidate
            }));
        });

		webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
			if (error) {
				stop(sessionId);
				return callback(error);
			}
			if (presenter === null) {
				stop(sessionId);
				return callback(noPresenterMessage);
			}

			presenter.webRtcEndpoint.connect(webRtcEndpoint, function(error) {
				if (error) {
					stop(sessionId);
					return callback(error);
				}
				if (presenter === null) {
					stop(sessionId);
					return callback(noPresenterMessage);
				}

				callback(null, sdpAnswer);
		        webRtcEndpoint.gatherCandidates(function(error) {
		            if (error) {
			            stop(sessionId);
			            return callback(error);
		            }
		        });
		    });
	    });
	});
}

function clearCandidatesQueue(sessionId) {
	if (candidatesQueue[sessionId]) {
		delete candidatesQueue[sessionId];
	}
}

function stop(sessionId) {
	if (presenter !== null && presenter.id == sessionId) {
		for (var i in viewers) {
			var viewer = viewers[i];
			if (viewer.ws) {
				viewer.ws.send(JSON.stringify({
					id : 'stopCommunication'
				}));
			}
		}
		presenter.pipeline.release();
		presenter = null;
		viewers = [];

	} else if (viewers[sessionId]) {
		viewers[sessionId].webRtcEndpoint.release();
		delete viewers[sessionId];
	}

	clearCandidatesQueue(sessionId);

  // if(recorder) {
  //   recorder.stop();
  //   recorder = null
  //   console.log("Rocord was stoped");
  // }
}

function onIceCandidate(sessionId, _candidate) {
    var candidate = kurento.getComplexType('IceCandidate')(_candidate);

    if (presenter && presenter.id === sessionId && presenter.webRtcEndpoint) {
        console.info('Sending presenter candidate');
        presenter.webRtcEndpoint.addIceCandidate(candidate);
    }
    else if (viewers[sessionId] && viewers[sessionId].webRtcEndpoint) {
        console.info('Sending viewer candidate');
        viewers[sessionId].webRtcEndpoint.addIceCandidate(candidate);
    }
    else if (listeners[sessionId] && listeners[sessionId].webRtcEndpoint) {
        console.info('Sending listener candidate');
        listeners[sessionId].webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

app.use(express.static(path.join(__dirname, 'static')));
