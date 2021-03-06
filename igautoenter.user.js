// ==UserScript==
// @name         IndieGala: Auto-enter Giveaways
// @version      2.2.2
// @description  Automatically enters IndieGala Giveaways
// @author       Hafas (https://github.com/Hafas/)
// @match        https://www.indiegala.com/giveaways*
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @require      https://greasemonkey.github.io/gm4-polyfill/gm4-polyfill.js
// @connect      api.steampowered.com
// @connect      store.steampowered.com
// ==/UserScript==

(function () {
  /**
   * change values to customize the script's behaviour
   */
  const options = {
    skipOwnedGames: false,
    skipDLCs: false,
    //set to 0 to ignore the number of participants
    maxParticipants: 0,
    //set to 0 to ignore the price
    maxPrice: 0,
    //Array of names of games
    gameBlacklist: [],
    onlyEnterGuaranteed: false,
    //Array of names of users
    userBlacklist: [],
    //Some giveaways don't link to the game directly but to a sub containing that game. IndieGala is displaying these games as "not owned" even if you own that game
    skipSubGiveaways: false,
    interceptAlert: false,
    //how many minutes to wait at the end of the line until restarting from the beginning
    waitOnEnd: 60,
    //how many seconds to wait for a respond by IndieGala
    timeout: 30,
    //Display logs
    debug: false,
    //Your Steam API key (keep it private!)
    steamApiKey: null,
    //Your Steam user id
    steamUserId: null
  };

  const waitOnEnd = options.waitOnEnd * 60 * 1000;
  const timeout = options.timeout * 1000;

  /**
   * current user state
   */
  const my = {
    level: undefined,
    coins: undefined,
    nextRecharge: undefined,
    ownedGames: new Set()
  };

  /**
   * entry point of the script
   */
  async function start () {
    if (!getCurrentPage()) {
      //I'm not on a giveaway list page. Script stops here.
      log("Current page is not a giveway list page. Stopping script.");
      return;
    }
    try {
      startWatchdog();
      const [level, userData, ownedGames] = await Promise.all([getLevel(), getUserData(), getOwnedGames()]);
      setLevel(level);
      setData(userData);
      setOwnedGames(ownedGames);
      log("myData:", my);
      if (!okToContinue()) {
        // will navigate to first page on next recharge
        return;
      }
      const giveaways = await getGiveaways();
      setOwned(giveaways);
      await setGameInfo(giveaways);
      await enterGiveaways(giveaways);
      if (okToContinue()) {
        navigateToNext();
      }
    } catch (err) {
      error("Something went wrong:", err);
    }
  }

  const IdType = {
    APP: Symbol(),
    SUB: Symbol()
  };

  /**
   * returns true if the logged in user has coins available.
   * if not, it will return false and trigger navigation to the first giveaway page on recharge
   */
  function okToContinue () {
    if (my.coins === 0) {
      info("No coins available. Waiting for recharge. Expected recharge at", new Date(new Date().getTime() + my.nextRecharge));
      setTimeout(navigateToStart, my.nextRecharge);
      return false;
    }
    return true;
  }

  /**
   * collects user information including level, coins and next recharge
   */
  async function getLevel () {
    const response = await request("/giveaways/get_user_level_and_coins");
    return response.json();
  }
  async function getUserData() {
    const response = await request("/profile");
    return response.text();
  }
  async function getOwnedGames() {
    const fetchOwnedGames = options.skipOwnedGames || options.skipDLCs === "missing_basegame";
    if (!fetchOwnedGames) {
      return [];
    }
    const { steamApiKey, steamUserId } = options;
    if (!steamApiKey || !steamUserId) {
      warn("You must set both 'steamApiKey' and 'steamUserId' to use 'skipOwnedGames'! Proceeding without checking owned games");
      return [];
    }
    let ownedGames = await getFromCache("ownedGames");
    if (ownedGames) {
      return ownedGames;
    }
    const { responseText } = await corsRequest(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${steamApiKey}&steamid=${steamUserId}&format=json`);
    const { games } = JSON.parse(responseText).response;
    ownedGames = games.map(({ appid }) => appid);
    await saveToCache("ownedGames", ownedGames, 60);
    return ownedGames;
  }

  /**
   * sets the owned-property of each giveaway
   */
  function setOwned (giveaways) {
    giveaways.forEach((giveaway) => {
      giveaway.owned = my.ownedGames.has(Number(giveaway.steamId));
      if (giveaway.owned) {
        log("I seem to own '%s' (gameId: '%s')", giveaway.name, giveaway.gameId);
      } else {
        log("I don't seem to own '%s' (gameId: '%s')", giveaway.name, giveaway.gameId);
      }
    });
  }

  async function setGameInfo (giveaways) {
    const fetchGameInfo = options.skipDLCs;
    if (!fetchGameInfo) {
      return;
    }
    const appids = Array.from(
      new Set(
        giveaways.map(({ steamId }) => steamId)
      )
    );
    const appsDetails = await getFromCache("appsDetails", {});
    await Promise.all(
      appids.map(
        async (appid) => {
          const details = appsDetails[appid];
          if (details) {
            return;
          }
          const { responseText } = await corsRequest(`https://store.steampowered.com/api/appdetails?appids=${appid}`);
          const result = JSON.parse(responseText);
          if (result === null) {
            warning("No details found for appid '%s'", appid);
            return;
          }
          if (result[appid].success !== true) {
            error("Failed to get details for appid '%s'", appid, result);
            return;
          }
          const { fullgame, type } = result[appid].data;
          const basegame = fullgame ? Number(fullgame.appid) : undefined;
          appsDetails[appid] = {
            basegame,
            type
          };
        }
      )
    )
    await saveToCache("appsDetails", appsDetails);
    giveaways.forEach((giveaway) => {
      const appid = giveaway.steamId;
      const details = appsDetails[appid];
      if (details) {
        const { basegame, type } = details;
        giveaway.gameType = type;
        if (basegame) {
          giveaway.ownBasegame = my.ownedGames.has(basegame);
        }
      }
    });
  }

  /**
   * puts the result of getUserData into the my-Object
   */
  function setLevel (data) {
    log("setLevel", "data", data);
    my.level = parseInt(data.current_level) || 0;
  }
  function setData (data) {
    try {
      const doc = document.implementation.createHTMLDocument("profile");
      doc.documentElement.innerHTML = data;
      my.nextRecharge = (parseInt(doc.getElementById("next-recharge-mins").textContent) + 1) * 60 * 1000;
      if (isNaN(my.nextRecharge)) {
        error("could not determine next recharge. Setting default value");
        my.nextRecharge = 20 * 60 * 1000;
      }
      my.coins = parseInt(doc.getElementsByClassName("galasilver-profile")[0].textContent);
      if (isNaN(my.coins)) {
        error("could not determine number of coins. Setting default value");
        my.coins = 240;
      }
    } catch (e) {
      warn("Failed to parse profile page. Account might be locked?", e);
      my.nextRecharge = my.nextRecharge || 20 * 60 * 1000;
      my.coins = my.coins || 240;
    }
  }
  function setOwnedGames (data) {
    my.ownedGames = new Set(data);
  }

  /**
   * iterates through each giveaway and enters them, if possible and desired
   */
  async function enterGiveaways (giveaways) {
    log("Entering giveaways", giveaways);
    for (let giveaway of giveaways) {
      if (!giveaway.shouldEnter()) {
        continue;
      }
      const payload = await giveaway.enter();
      log("giveaway entered", "payload", payload);
      if (payload.status === "ok") {
        my.coins = payload.new_amount;
      } else {
        error("Failed to enter giveaway. Status: %s. My: %o", payload.status, my);
        if (payload.status === "insufficient_credit") {
          //we know that our coins value is lower than the price to enter this giveaway, so we can set a guessed value
          if (isNaN(my.coins)) {
            my.coins = giveaway.price - 1;
          } else {
            my.coins = Math.min(my.coins, giveaway.price - 1);
          }
        }
      }
    }
  }

  /**
   * parses and returns giveaways whenever the DOM is ready
   */
  async function getGiveaways () {
    while (!document.querySelector("#ajax-giv-list-cont .giv-list-cont")) {
      //content isn't there yet, so we wait until it is
      log("waiting for content to come ...");
      await wait(300);
    }
    return parseGiveaways();
  }

  const APP_ID_PATTERN = /^([0-9]+)(?:_(?:bonus|promo|ig))?$/;
  const SUB_ID_PATTERN = /^sub_([0-9]+)$/;
  const FALLBACK_ID_PATTERN = /([0-9]+)/;
  /**
   * parses the DOM and extracts the giveaway. Returns Giveaway-Objects, which include the following properties:
   id {String} - the giveaway id
   name {String} - name of the game
   price {Integer} - the coins needed to enter the giveaway
   minLevel {Integer} - the minimum level to enter the giveaway
   participants {Integer} - the current number of participants, that entered that giveaway
   guaranteed {Boolean} - whether or not the giveaway is a guaranteed one
   by {String} - name of the user who created the giveaway
   entered {Boolean} - wheter or not the logged in user has already entered the giveaway
   steamId {String} - the id Steam gave this game
   idType {"APP" | "SUB" | null} - "APP" if the steamId is an appId. "SUB" if the steamId is a subId. null if this script is not sure
   gameId {String} - the gameId IndieGala gave this game. It's usually the appId with or without a suffix, or the subId with a "sub_"-prefix
   */
  function parseGiveaways () {
    return Array.from(document.getElementsByClassName("tickets-col")).map((giveawayDOM) => {
      const gameId = giveawayDOM.getElementsByClassName("giveaway-game-id")[0].attributes.value.value;
      let match;
      let steamId = null;
      let idType = null;
      if (match = APP_ID_PATTERN.exec(gameId)) {
        steamId = match[1];
        idType = IdType.APP;
      } else if (match = SUB_ID_PATTERN.exec(gameId)) {
        steamId = match[1];
        idType = IdType.SUB;
      } else {
        error("Unrecognized id type in '%s'", gameId);
        if (match = FALLBACK_ID_PATTERN.exec(gameId)) {
          steamId = match[1];
        }
      }
      return new Giveaway({
        id: getGiveawayId(giveawayDOM),
        name: getGiveawayName(giveawayDOM),
        price: getGiveawayPrice(giveawayDOM),
        minLevel: getGiveawayMinLevel(giveawayDOM),
        //will be filled in later in setOwned()
        owned: undefined,
        participants: getGiveawayParticipants(giveawayDOM),
        guaranteed: getGiveawayGuaranteed(giveawayDOM),
        by: getGiveawayBy(giveawayDOM),
        // TODO instead of 'entered' there should be something like 'boughtTickets' to consider these extra odds giveaways
        entered: getGiveawayEntered(giveawayDOM),
        steamId: steamId,
        idType: idType,
        gameId: gameId,
        gameType: undefined,
        ownBasegame: undefined
      });
    });
  }

  const withFailSafe = (fn) => (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      error(...args, err);
      return undefined;
    }
  }

  const getGiveawayId = withFailSafe((giveawayDOM) => giveawayDOM.querySelector("[rel]").attributes.rel.value);
  const getGiveawayName = withFailSafe((giveawayDOM) => giveawayDOM.getElementsByTagName("a")[0].attributes.title.value);
  const getGiveawayPrice = withFailSafe((giveawayDOM) => parseInt(giveawayDOM.getElementsByClassName("ticket-price")[0].textContent));
  const getGiveawayMinLevel = withFailSafe((giveawayDOM) => parseInt(giveawayDOM.getElementsByClassName("type-level")[0].textContent));
  const getGiveawayParticipants = withFailSafe((giveawayDOM) => parseInt(giveawayDOM.getElementsByClassName("tickets-sold")[0].textContent));
  const getGiveawayGuaranteed = withFailSafe((giveawayDOM) => giveawayDOM.getElementsByClassName("price-type-cont")[0].classList.contains("palette-background-11"));
  const getGiveawayBy = withFailSafe((giveawayDOM) => giveawayDOM.getElementsByClassName("steamnick")[0].getElementsByTagName("a")[0].textContent);
  const getGiveawayEntered = withFailSafe((giveawayDOM) => giveawayDOM.getElementsByTagName("aside").length === 0);

  /**
   * utility function that checks if a name is in a blacklist
   */
  const isInBlacklist = (blacklist) => (name) => {
    if (!Array.isArray(blacklist)) {
      return false;
    }
    for (var i = 0; i < blacklist.length; ++i) {
      var blacklistItem = blacklist[i];
      if (blacklistItem instanceof RegExp) {
        if (blacklistItem.test(name)) {
          return true;
        }
      } if (name === blacklistItem) {
        return true;
      }
    }
    return false;
  }

  /**
   * whether or not a game by name is in the blacklist
   */
  const isInGameBlacklist = isInBlacklist(options.gameBlacklist);

  /**
   * whether or not a user by name is in the blacklist
   */
  const isInUserBlacklist = isInBlacklist(options.userBlacklist);

  class Giveaway {
    constructor (props) {
      for (let key in props) {
        if (props.hasOwnProperty(key)) {
          this[key] = props[key];
        }
      }
    }

    /**
     * returns true if the script can and should enter a giveaway
     */
    shouldEnter () {
      if (this.entered) {
        log("Not entering '%s' because I already entered", this.name);
        return false;
      }
      if (this.owned && options.skipOwnedGames) {
        log("Not entering '%s' because I already own it (skipOwnedGames? %s)", this.name, options.skipOwnedGames);
        return false;
      }
      if (this.gameType === "dlc" && options.skipDLCs) {
        if (options.skipDLCs === "missing_basegame") {
          if (!this.ownBasegame) {
            log("Not entering '%s' because I don't own the basegame of this DLC (skipDLCs? %s)", this.name, options.skipDLCs);
            return false;
          }
        } else {
          log("Not entering '%s' because the game is a DLC (skipDLCs? %s)", this.name, options.skipDLCs);
          return false;
        }
      }
      if (isInGameBlacklist(this.name)) {
        log("Not entering '%s' because this game is on my blacklist", this.name);
        return false;
      }
      if (isInUserBlacklist(this.by)) {
        log("Not entering '%s' because the user '%s' is on my blacklist", this.name, this.by);
        return false;
      }
      if (!this.guaranteed && options.onlyEnterGuaranteed) {
        log("Not entering '%s' because the key is not guaranteed to work (onlyEnterGuaranteed? %s)", this.name, options.onlyEnteredGuaranteed);
        return false;
      }
      if (options.maxParticipants && this.participants > options.maxParticipants) {
        log("Not entering '%s' because of too many are participating (participants: %s, max: %s)", this.name, this.participants, options.maxParticipants);
        return false;
      }
      if (options.maxPrice && this.price > options.maxPrice) {
        log("Not entering '%s' because of too expensive price (price: %s, max: %s)", this.name, this.price, options.maxPrice);
        return false;
      }
      if (this.idType === IdType.SUB && options.skipSubGiveaways) {
        log("Not entering '%s' because this giveaway is linked to a sub (skipSubGiveaways? %s)", this.name, options.skipSubGiveaways);
        return false;
      }
      if (this.minLevel > my.level) {
        log("Not entering '%s' because my level is insufficient (mine: %s, needed: %s)", this.name, my.level, this.minLevel);
        return false;
      }
      if (this.price > my.coins) {
        log("Not entering '%s' because my funds are insufficient (mine: %s, needed: %s)", this.name, my.coins, this.price);
        return false;
      }
      return true;
    }

    /**
     * sends a POST-request to enter a giveaway
     */
    async enter () {
      info("Entering giveaway", this);
      const response = await request("/giveaways/new_entry", {
        method: "POST",
        body: JSON.stringify({giv_id: this.id, ticket_price: this.price})
      });
      return response.json();
    }
  }

  /**
   * navigate to the first giveaway page
   */
  function navigateToStart () {
    navigateToPage(1);
  }

  /**
   * navigates to the next giveaway page; navigates to the first page if there is no next page
   */
  function navigateToNext () {
    if (hasNext()) {
      navigateToPage(getCurrentPage() + 1);
    } else {
      info("Reached the end of the line. Waiting %s minutes", options.waitOnEnd);
      setTimeout(navigateToStart, waitOnEnd);
    }
  }

  /**
   * navigates to {pageNumber}th giveaway page
   */
  function navigateToPage (pageNumber) {
    var target = "/giveaways/" + pageNumber + "/expiry/asc/level/" + (my.level === 0 ? "0" : "all");
    log("navigating to", target);
    window.location.href = target;
    setTimeout(function () {
      log("Navigation seems stuck. Retrying ...");
      navigateToPage(pageNumber);
    }, timeout);
  }

  /**
   * calls console[method] if debug is enabled
   */
  const printDebug = (method) => (...args) => {
    if (options.debug) {
      console[method](...args);
    }
  }

  const log = printDebug("log");
  const error = printDebug("error");
  const info = printDebug("info");
  const warn = printDebug("warn");

  var PAGE_NUMBER_PATTERN = /^\/giveaways(?:\/([0-9]+)\/|\/?$)/;
  /**
   * returns the current giveaway page
   */
  function getCurrentPage () {
    var currentPath = window.location.pathname;
    var match = PAGE_NUMBER_PATTERN.exec(currentPath);
    if (match === null) {
      return null;
    }
    if (!match[1]) {
      return 1;
    }
    return parseInt(match[1]);
  }

  /**
   * returns true if there is a next page
   */
  function hasNext () {
    //find the red links and see if one of them is "NEXT"
    const links = document.querySelectorAll("a.prev-next.palette-background-1");
    for (let link of links) {
      if (link.textContent.includes("NEXT")) {
        return true;
      }
    }
    return false;
  }

  if (options.interceptAlert) {
    window.alert = function (message) {
      warn("alert intercepted:", message);
    };
  }

  /**
   * sends an HTTP-Request
   */
  async function request (resource, _options) {
    const options = Object.assign({
      credentials: "include"
    }, _options);
    try {
      const response = await fetch(document.location.origin + resource, options);
      if (response.ok) {
        return response;
      }
      const timeoutDelay = response.status === 403 ? 60 * 1000 : 10 * 1000;
      await wait(timeoutDelay);
      // retry
      return request(resource, _options);
    } catch (err) {
      await wait(1000);
      // retry
      return request(resource, _options);
    }
  }

  async function corsRequest (resource, options) {
    return new Promise((resolve, reject) => {
      GM.xmlHttpRequest(Object.assign({
        method: "GET",
        url: resource
      }, options, {
        onerror (response) {
          error("corsRequest failed", response);
          reject();
        },
        onload (response) {
          resolve(response);
        }
      }));
    });
  }

  function wait (timeout) {
    return new Promise((resolve) => setTimeout(resolve, timeout));
  }

  function reload () {
    log("reloading page");
    window.location.reload();
  }

  async function startWatchdog () {
		while (true) {
      // keep watch for the warning cover - if it becomes visible reload the page
      if (document.querySelector(".warning-cover").offsetParent) {
        await wait(5000);
        reload();
        break;
      }
      await wait(1000);
    }
  }

  async function getFromCache (...args) {
    const [key, defaultValue] = args;
    const rawValue = await GM.getValue(key, defaultValue);
    if (rawValue === undefined && args.length === 2) {
      return defaultValue;
    }
    if (!rawValue || typeof rawValue !== "string") {
      return rawValue;
    }
    try {
      const { expires, value } = JSON.parse(rawValue);
      if (expires && new Date().getTime() > new Date(expires).getTime()) {
        //value has expired
        await GM.deleteValue(key);
        return GM.getValue(key, defaultValue);
      }
      return value;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return rawValue;
      }
      throw error;
    }
  }

  async function saveToCache (key, value, duration) {
    // if duration is not set then the resource does not expire
    const expires = duration ? new Date(new Date().getTime() + duration * 60 * 1000) : null
    const object = {
      expires,
      value
    };
    await GM.setValue(key, JSON.stringify(object));
  }

  start();
})();
