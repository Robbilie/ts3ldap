
	"use strict";

	var ldap 		= require("ldapjs");
	var ts 			= require("ts3sq");
	var fs 			= require("fs");

	var config 		= JSON.parse(fs.readFileSync("config.json"));

	var clientLDAP 	= ldap.createClient({ url: "ldap://service.eneticum.de" });
	var clientTS 	= new ts.ServerQuery("localhost", 10011);

	clientTS.on("ready", function () {
		clientTS.execute(`login ${config.sq.username} ${config.sq.password}`, console.log);
		
		clientTS.execute('use 1', function (element) { });

		clientTS.execute('servernotifyregister event=server');
	});
	
	clientTS.on("notify", function (notification) {
		if (notification.type == "notifycliententerview") {
			console.log(notification.body[0].client_nickname + " has connected");
			processClient(notification.body[0]);
		}
	});

	clientTS.on("error", console.log);

	clientTS.on("close", function () { });

	function processClient (notif) {
		console.log("process client", notif);
		var name 	= notif.client_nickname;
		var uid 	= notif.client_unique_identifier;
		var clid 	= notif.clid;

		clientLDAP.bind(`id=${config.ldap.keyid},ou=EASKey,dc=eneticum`, config.ldap.secret, (err) => {
			console.log("bound");
			if(err) return console.log(err);
			clientLDAP.search(config.ldap.path, { filter: config.ldap.filter.replace("%uid", new Buffer(uid, "base64").toString("base64")), scope: 'sub' }, (err, res) => {
				console.log("search");
				var entries = [];
				res.on("searchEntry", (entry) => {
					console.log("got entry");
					entries.push(entry.object);
				});
				res.on("searchReference", (referral) => {
					console.log('referral: ' + referral.uris.join());
				});
				res.on("error", (err) => {
					console.error('error: ' + err.message);
				});
				res.on("end", (result) => {
					console.log('status: ' + result.status);
					if(entries.length == 0) 
						return warnUser({ type: "kickmsg", entry: entries[0], uid: uid, clid: clid, name: name, msg: "Not registered or not allowed to enter. Register here: https://service.eneticum.de/" });
					if(entries.length > 1) 
						return warnUser({ type: "kickmsg", entry: entries[0], uid: uid, clid: clid, name: name, msg: "You can only assign your TS3UID to one character, please remove it from any others." });
					if(name.indexOf(entries[0].characterName) != 0) 
						return warnUser({ type: "name", notif: notif, entry: entries[0], uid: uid, clid: clid, name: name, warning: 0 });
					setupUser(notif, entries[0]);
				});
			});
		})
	}

	function warnUser (data) {
		switch (data.type) {
			case "name":
				clientTS.execute(`clientinfo clid=${data.clid}`, (res) => {
					if(res.response.length != 1) return;
					if(res.response[0].client_nickname.indexOf(data.entry.characterName) != 0) {
						console.log(res.response[0].client_nickname, data.entry.characterName);
						if(data.warning < config.warning.times) {
							console.log("poke");
							clientTS.execute(`clientpoke clid=${data.clid} msg=${ts.escapeString("Please change your name to start with your character name and reconnect.")}`);
							data.warning++;
							setTimeout(() => { warnUser(data); }, config.warning.timeout);
						} else {
							console.log("kick");
							clientTS.execute(`clientkick clid=${data.clid} reasonid=5 reasonmsg=${"You did not change your name in time.".replace(/ /g, "\\s")}`);
						}
					} else {
						data.notif = res.response[0];
						processClient(data.notif);
					}
				});
				break;
			case "kickmsg":
				console.log(data.msg);
				clientTS.execute(`clientpoke clid=${data.clid} msg=${ts.escapeString(data.msg)}`);
				clientTS.execute(`clientkick clid=${data.clid} reasonid=5 reasonmsg=${ts.escapeString(data.msg)}`);
				break;
		}
	}

	function setupUser (notif, entry) {
		console.log("setting up user");
		clientTS.execute(`clientgetdbidfromuid cluid=${new Buffer(notif.client_unique_identifier, "base64").toString("base64")}`, (res) => {
			clientTS.execute(`servergroupsbyclientid cldbid=${res.response[0].cldbid}`, (res) => {
				
				var chargroups 		= typeof entry.groups === "string" ? [entry.groups] : entry.groups;
				var servergroups 	= res.response;

				chargroups = chargroups.map((i) => {
					var name = i;
					if(name.indexOf("|") > 28) {
						name = name.substr(0, 28) + name.slice(name.indexOf("|"));
					}
					if(name.length > 30) name = name.substr(0, 30);
					name = name.replace(/\|/g, "%");
					return name;
				});

				console.log("chargroups", chargroups);
				var toAddGroups 	= chargroups.filter((i) => { return servergroups.filter((j) => { return j.name == i; }).length == 0; });
				var toRemoveGroups 	= servergroups.filter((i) => { return i.name == "Server Admin" ? false : chargroups.indexOf(i.name) < 0; });

				console.log("add", toAddGroups);
				toAddGroups.map((i) => { addToGroup(res.response[0].cldbid, i); });
				console.log("rem", toRemoveGroups);
				toRemoveGroups.map((i) => { removeFromGroup(res.response[0].cldbid, i.name); });
			});
		});
	}

	function addToGroup (cldbid, name) {
		addOrCreateGroup(name, (sgid) => {
			console.log("sgid", sgid);
			clientTS.execute(`servergroupaddclient sgid=${sgid} cldbid=${cldbid}`, (res) => {
				console.log("added", res);
			});
		});
	}

	function addOrCreateGroup (name, cb) {
		clientTS.execute(`servergrouplist`, (res) => {
			console.log(res);
			var sgid;
			res.response.filter((i) => { if(i.name == name) sgid = i.sgid; return i.name == name; });
			if(sgid) {
				cb(sgid);
			} else {
				clientTS.execute(`servergroupadd name=${ts.escapeString(name)}`, (res) => {
					sgid = res.response[0].sgid;
					if(config.sq.useTicker && name.length < 6 && name != "CEO")
						clientTS.execute(`servergroupaddperm sgid=${sgid} permsid=i_group_show_name_in_tree permvalue=1 permnegated=0 permskip=0`, (res) => {
							console.log("new", sgid, res);
							cb(sgid);
						});
					else
						cb(sgid);
				});
			}
		});
	}

	function removeFromGroup (cldbid, name) {
		clientTS.execute(`servergrouplist`, (res) => {
			var sgid;
			res.response.filter((i) => { if(i.name == name) sgid = i.sgid; return i.name == name; });
			if(sgid) {
				clientTS.execute(`servergroupdelclient sgid=${sgid} cldbid=${cldbid}`, (res) => {
					console.log("removed", res);
				});
			}
		});
	}

	process.on("SIGINT", (code) =>{
		clientTS.execute("logout");
		clientLDAP.unbind();
		process.exit();
	});