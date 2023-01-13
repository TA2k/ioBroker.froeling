"use strict";

/*
 * Created with @iobroker/create-adapter v2.0.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios").default;
const Json2iob = require("./lib/json2iob");

class Froeling extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: "froeling",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.deviceArray = [];
    this.componentsArray = {};
    this.json2iob = new Json2iob(this);
    this.requestClient = axios.create();
    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.session = {};
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState("info.connection", false, true);
    if (this.config.interval < 0.5) {
      this.log.info("Set interval to minimum 0.5");
      this.config.interval = 0.5;
    }

    this.subscribeStates("*");

    await this.login();

    if (this.token) {
      await this.getDeviceList();
      await this.updateDevices();
      this.updateInterval = setInterval(async () => {
        await this.updateDevices();
      }, this.config.interval * 60 * 1000);
      this.refreshTokenInterval = setInterval(() => {
        this.login();
      }, 11.5 * 60 * 60 * 1000);
      this.deviceListInterval = setInterval(() => {
        this.getDeviceList();
      }, 12 * 60 * 60 * 1000);
    }
  }
  async login() {
    await this.requestClient({
      method: "post",
      url: "https://connect-api.froeling.com/app/v1.0/resources/loginNew",
      headers: {
        "Content-Type": "application/json",
        Connection: "keep-alive",
        Accept: "*/*",
        "User-Agent": "Froeling PROD/2107.1 (com.froeling.connect-ios; build:2107.1.01; iOS 14.8.0) Alamofire/4.8.1",
        "Accept-Language": "de",
      },
      data: JSON.stringify({
        osType: "IOS",
        userName: this.config.username,
        password: this.config.password,
      }),
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.token = res.headers["authorization"];
        this.setState("info.connection", true, true);
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
  }
  async cleanOldVersion(id) {
    const cleanOldVersion = await this.getObjectAsync("oldVersionCleaned");
    if (!cleanOldVersion) {
      this.log.info("Clean old version component list");
      await this.delObjectAsync(id + ".componentList", { recursive: true });
      await this.setObjectNotExistsAsync("oldVersionCleaned", {
        type: "state",
        common: {
          type: "boolean",
          role: "boolean",
          write: false,
          read: true,
        },
        native: {},
      });

      this.log.info("Done with cleaning");
    }
  }
  async getDeviceList() {
    const urlArray = [
      "https://connect-api.froeling.com/app/v1.0/resources/user/getFacilities",
      "https://connect-api.froeling.com/app/v1.0/resources/user/getServiceFacilities",
    ];
    for (const url of urlArray) {
      await this.requestClient({
        method: "get",
        url: url,
        headers: {
          Connection: "keep-alive",
          Accept: "*/*",
          "User-Agent": "Froeling PROD/2107.1 (com.froeling.connect-ios; build:2107.1.01; iOS 14.8.0) Alamofire/4.8.1",
          "Accept-Language": "de",
          Authorization: this.token,
        },
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          this.log.info(`${res.data.length} devices found`);
          this.deviceArray = [];
          for (const device of res.data) {
            const id = device.id.toString();

            this.deviceArray.push(id);
            await this.cleanOldVersion(id);
            const name = device.name;
            await this.setObjectNotExistsAsync(id, {
              type: "device",
              common: {
                name: name,
              },
              native: {},
            });
            // await this.setObjectNotExistsAsync(id + ".remote", {
            //     type: "channel",
            //     common: {
            //         name: "Remote Controls",
            //     },
            //     native: {},
            // });

            const remoteArray = [];
            remoteArray.forEach((remote) => {
              this.setObjectNotExists(device.vin + ".remote." + remote.command, {
                type: "state",
                common: {
                  name: remote.name || "",
                  type: remote.type || "boolean",
                  role: remote.role || "boolean",
                  write: true,
                  read: true,
                },
                native: {},
              });
            });
            this.json2iob.parse(id, device);

            await this.requestClient({
              method: "get",
              url: "https://connect-api.froeling.com/fcs/v1.0/resources/user/" + this.session.userId + "/facility/" + id + "/componentList",
              headers: {
                Connection: "keep-alive",
                Accept: "*/*",
                "User-Agent": "Froeling PROD/2107.1 (com.froeling.connect-ios; build:2107.1.01; iOS 14.8.0) Alamofire/4.8.1",
                "Accept-Language": "de",
                Authorization: this.token,
              },
            })
              .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));
                this.log.info(`${res.data.length} components found`);
                const componentArray = [];
                for (const component of res.data) {
                  componentArray.push({
                    id: component.componentId,
                    name: component.displayName.replace(/\./g, "").replace(/\ /g, "") + "-" + component.displayCategory,
                  });
                }
                this.componentsArray[id] = componentArray;
                await this.setObjectNotExistsAsync(id + ".componentList", {
                  type: "device",
                  common: {
                    name: "Component list to change component states",
                  },
                  native: {},
                });

                this.json2iob.parse(id + ".componentList", res.data, { preferedArrayName: "displayName+displayCategory" });
              })
              .catch((error) => {
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
              });
            const infoUrl =
              "https://connect-api.froeling.com/connect/v1.0/resources/service/user/" + this.session.userId + "/facility/" + id + "/info";
            await this.requestClient({
              method: "get",
              url: infoUrl,
              headers: {
                Connection: "keep-alive",
                Accept: "*/*",
                "User-Agent": "Froeling PROD/2107.1 (com.froeling.connect-ios; build:2107.1.01; iOS 14.8.0) Alamofire/4.8.1",
                "Accept-Language": "de",
                Authorization: this.token,
              },
            })
              .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                if (!res.data) {
                  return;
                }
                this.json2iob.parse(id, res.data);
              })
              .catch((error) => {
                this.log.debug(url);
                this.log.debug(error);
                error.response && this.log.debug(JSON.stringify(error.response.data));
              });
          }
        })
        .catch((error) => {
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
    }
  }

  async updateDevices() {
    const statusArray = [
      {
        path: "details",
        url: "https://connect-api.froeling.com/app/v1.0/resources/facility/getFacilityDetails/$id",
        desc: "Detailed status of the devices and to change the state of the devices",
      },

      {
        path: "errors",
        url: "https://connect-api.froeling.com/app/v1.0/resources/facility/getErrors/$id",
        desc: "Errors of the device",
      },
    ];

    const headers = {
      Connection: "keep-alive",
      Accept: "*/*",
      "User-Agent": "Froeling PROD/2107.1 (com.froeling.connect-ios; build:2107.1.01; iOS 14.8.0) Alamofire/4.8.1",
      "Accept-Language": "de",
      Authorization: this.token,
    };
    this.deviceArray.forEach(async (id) => {
      statusArray.forEach(async (element) => {
        const url = element.url.replace("$id", id);

        await this.requestClient({
          method: "get",
          url: url,
          headers: headers,
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            if (!res.data) {
              return;
            }
            const data = res.data;

            const forceIndex = null;
            let preferedArrayName = "label";
            if (element.path === "details") {
              preferedArrayName = "name+parameter/paramId";
            }

            this.json2iob.parse(id + "." + element.path, data, {
              forceIndex: forceIndex,
              preferedArrayName: preferedArrayName,
              autoCast: true,
              channelName: element.desc,
            });
          })
          .catch((error) => {
            if (error.response) {
              if (error.response.status === 401) {
                error.response && this.log.debug(JSON.stringify(error.response.data));
                this.log.info(element.path + " receive 401 error. Refresh Token in 5min");
                this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
                this.refreshTokenTimeout = setTimeout(() => {
                  this.login();
                }, 1000 * 60 * 5);

                return;
              }
            }
            this.log.error(url);
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      });

      for (const component of this.componentsArray[id]) {
        const url =
          "https://connect-api.froeling.com/fcs/v1.0/resources/user/" + this.session.userId + "/facility/" + id + "/component/" + component.id;
        await this.requestClient({
          method: "get",
          url: url,
          headers: headers,
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            if (!res.data) {
              return;
            }
            const data = res.data;
            const forceIndex = null;
            const preferedArrayName = "label";
            this.json2iob.parse(id + ".componentList." + component.name, data, {
              forceIndex: forceIndex,
              preferedArrayName: preferedArrayName,
              autoCast: true,
              channelName: "Component " + component.name,
            });
          })
          .catch((error) => {
            if (error.response) {
              if (error.response.status === 401) {
                error.response && this.log.debug(JSON.stringify(error.response.data));
                this.log.info(url + " receive 401 error. Refresh Token in 5min");
                this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
                this.refreshTokenTimeout = setTimeout(() => {
                  this.login();
                }, 1000 * 60 * 5);

                return;
              }
            }
            this.log.error(url);
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      }
    });
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState("info.connection", false, true);
      this.refreshTimeout && clearTimeout(this.refreshTimeout);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.updateInterval && clearInterval(this.updateInterval);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      this.deviceListInterval && clearInterval(this.deviceListInterval);
      callback();
    } catch (e) {
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        if (id.indexOf(".setValue") === -1) {
          this.log.info("please use setValue Object to set values");
          return;
        }
        const deviceId = id.split(".")[2];
        const parentPath = id.split(".").slice(1, -1).slice(1).join(".");

        const paramIdState = await this.getStateAsync(parentPath + ".paramId");
        const menuTypeState = await this.getStateAsync(parentPath + ".menuType");
        const idState = await this.getStateAsync(parentPath + ".id");
        if (!paramIdState && !menuTypeState && !idState) {
          this.log.error("missing id states");
          return;
        }

        let url = "";
        let data = {};
        if (idState) {
          data = { value: state.val };
          url =
            "https://connect-api.froeling.com/fcs/v1.0/resources/user/" + this.session.userId + "/facility/" + deviceId + "/parameter/" + idState.val;
        } else {
          url = "https://connect-api.froeling.com/app/v1.0/resources/facility/setParam/" + deviceId;
          data = { paramId: paramIdState.val, menuType: menuTypeState.val, value: state.val };
        }
        this.log.debug(JSON.stringify(data));
        await this.requestClient({
          method: "put",
          url: url,
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            Accept: "*/*",
            Connection: "keep-alive",
            "User-Agent": "Froeling PROD/2107.1 (com.froeling.connect-ios; build:2107.1.01; iOS 14.8.0) Alamofire/4.8.1",
            "Accept-Language": "de",
            Authorization: this.token,
          },
          data: data,
        })
          .then((res) => {
            this.log.info(JSON.stringify(res.data));
            return res.data;
          })
          .catch((error) => {
            if (error.response && error.response.status === 304) {
              this.log.info("Value not changed");
              return;
            }
            this.log.error(error);
            if (error.response) {
              this.log.error(JSON.stringify(error.response.data));
            }
          });

        this.refreshTimeout && clearTimeout(this.refreshTimeout);
        this.refreshTimeout = setTimeout(async () => {
          await this.updateDevices();
        }, 10 * 1000);
      }
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Froeling(options);
} else {
  // otherwise start the instance directly
  new Froeling();
}
