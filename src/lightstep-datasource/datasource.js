import _ from 'lodash';
import moment from 'moment';
import appEvents from 'app/core/app_events';

const maxDataPointsServer = 1440;
const minResolutionServer = 60000;

// TODO - this is a work around given the existing graph API
// Having a better mechanism for click capture would be ideal.
appEvents.on('graph-click', options => {
  const link = _.get(options, [
    'ctrl',
    'dataList',
    _.get(options, ['item', 'seriesIndex']),
    'datapoints',
    _.get(options, ['item', 'dataIndex']),
    'link',
  ]);
  if (link) {
    window.open(link, '_blank');
  }
});

export class LightStepDatasource {
  constructor(instanceSettings, $q, backendSrv, templateSrv) {
    this.type = instanceSettings.type;
    this.url = instanceSettings.url;
    this.dashboardURL = instanceSettings.jsonData.dashboardURL;
    this.name = instanceSettings.name;
    this.q = $q;
    this.backendSrv = backendSrv;
    this.templateSrv = templateSrv;
    this.organizationName = instanceSettings.jsonData.organizationName;
    this.projectName = instanceSettings.jsonData.projectName;
    this.apiKey = instanceSettings.jsonData.apiKey;
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': "BEARER " + this.apiKey,
    };
  }

  query(options) {
    const targets = options.targets.filter(t => !t.hide);
    const maxDataPoints = options.maxDataPoints;

    if (targets.length <= 0) {
      return this.q.when({data: []});
    }

    const responses = targets.map(target => {
      const savedSearchID = this.templateSrv.replace(target.target);
      const savedSearchName = this.templateSrv.replaceWithText(target.target);

      if (!savedSearchID) {
        return this.q.when(undefined);
      }

      const query = this.buildQueryParameters(options, target, maxDataPoints);
      const showErrorCountsAsRate = Boolean(target.showErrorCountsAsRate); 
      const response = this.doRequest({
        url: `${this.url}/public/v0.1/${this.organizationName}/projects/${this.projectName}/searches/${savedSearchID}/timeseries`,
        method: 'GET',
        params: query,
      });

      response.then(result => {
        if (result && result["data"]["data"]) {
          if (target.displayName) {
            result["data"]["data"]["name"] = this.templateSrv.replaceWithText(target.displayName);
          } else {
            result["data"]["data"]["name"] = savedSearchName;
          }
        }
      });

      return response.then((res) => {
        res.showErrorCountsAsRate = showErrorCountsAsRate;
        return res;
      });
    });

    return this.q.all(responses).then(results => {
      const data = _.flatMap(results, result => {
        if (!result) {
          return [];
        }

        const data = result["data"]["data"];
        const attributes = data["attributes"];
        const name = data["name"];
        const ops = this.parseCount(`${name} Ops counts`, "ops-counts", attributes);
        let errs = this.parseCount(`${name} Error counts`, "error-counts", attributes);
        if (result.showErrorCountsAsRate) {
          errs = this.parseRateFromCounts(`${name} Error rate`, errs, ops);
        }

        return _.concat(
          this.parseLatencies(name, attributes),
          this.parseExemplars(name, attributes, maxDataPoints),
          ops,
          errs,
        );
      });

      return { data: data };
    });
  }

  testDatasource() {
    return this.doRequest({
      url: `${this.url}/public/v0.1/${this.organizationName}/projects/${this.projectName}`,
      method: 'GET',
    }).then(response => {
      if (response.status === 200) {
        return { status: "success", message: "Data source is working", title: "Success" };
      }
    }).catch(error => {
      return { status: "error", message: error, title: "Error " };
    });
  }

  annotationQuery(options) {
    return this.q.when({});
  }

  metricFindQuery() {
    return this.doRequest({
      url: `${this.url}/public/v0.1/${this.organizationName}/projects/${this.projectName}/searches`,
      method: 'GET',
    }).then(response => {
      const searches = response.data.data;
      return _.flatMap(searches, search => {
        const attributes = search["attributes"];
        const name = attributes["name"];
        const query = attributes["query"];
        const savedSearchId = search["id"];

        // Don't duplicate if the name and query are the same
        if (name.trim() === query.trim()) {
          return [ { text: name, value: savedSearchId } ];
        }

        return [
          { text: query, value: savedSearchId },
          { text: name, value: savedSearchId },
        ];
      });
    });
  }

  doRequest(options) {
    options.headers = this.headers();
    return this.backendSrv.datasourceRequest(options);
  }

  buildQueryParameters(options, target, maxDataPoints) {
    const oldest = options.range.from;
    const youngest = options.range.to;

    const resolutionMs = Math.max(
      youngest.diff(oldest) / Math.min(
        maxDataPoints,
        maxDataPointsServer
      ),
      minResolutionServer
    );

    return {
      "oldest-time": oldest.format(),
      "youngest-time": youngest.format(),
      "resolution-ms": Math.floor(resolutionMs),
      "include-exemplars": target.showExemplars ? "1" : "0",
      "include-ops-counts": target.showOpsCounts ? "1" : "0",
      "include-error-counts": target.showErrorCounts ? "1" : "0",
      "percentile": this.extractPercentiles(target.percentiles),
    };
  }

  parseLatencies(name, attributes) {
    if (!attributes["time-windows"] || !attributes["latencies"]) {
      return [];
    }

    const timeWindows = attributes["time-windows"].map(timeWindow => {
      const oldest = moment(timeWindow["oldest-time"]);
      const youngest = moment(timeWindow["youngest-time"]);
      return moment((oldest + youngest) / 2);
    });

    return attributes["latencies"].map(latencies => {
      return {
        target: `${name} p${latencies["percentile"]}`,
        datapoints: _.zip(latencies["latency-ms"], timeWindows),
      };
    })
  }

  parseExemplars(name, attributes, maxDataPoints) {
    const exemplars = attributes["exemplars"];
    if (!exemplars) {
      return [];
    }
    const exemplarMap = _.groupBy(exemplars, exemplar => exemplar["has_error"]);

    return _.concat(
      this.parseExemplar(`${name} traces`, exemplarMap[false], maxDataPoints),
      this.parseExemplar(`${name} error traces`, exemplarMap[true], maxDataPoints),
    )
  }

  parseExemplar(name, exemplars, maxDataPoints) {
    if (!exemplars) {
      return []
    }
    if (maxDataPoints && exemplars.length > maxDataPoints) {
      const skip = Math.ceil(exemplars.length / maxDataPoints);
      exemplars = exemplars.filter((ignored, index) => index % skip === 0);
    }
    return [{
      target: name,
      datapoints: exemplars.map(exemplar => {
        return {
          0: exemplar["duration_micros"] / 1000,
          1: moment(((exemplar["oldest_micros"] + exemplar["youngest_micros"]) / 2) / 1000),
          "link": this.traceLink(exemplar),
        };
      }),
    }];
  }

  traceLink(exemplar) {
    const spanGuid = exemplar["span_guid"];
    if (!spanGuid) {
      return
    }
    return `${this.dashboardURL}/${this.projectName}/trace?span_guid=${spanGuid}`
  }

  parseCount(name, key, attributes) {
    if (!attributes["time-windows"] || !attributes[key]) {
      return [];
    }

    const timeWindows = attributes["time-windows"].map(timeWindow => {
      const oldest = moment(timeWindow["oldest-time"]);
      const youngest = moment(timeWindow["youngest-time"]);
      return moment((oldest + youngest) / 2);
    });

    return [{
      target: name,
      datapoints: _.zip(attributes[key], timeWindows),
    }]
  }

  parseRateFromCounts(name, errors, ops) {
    if (!errors[0] || !ops[0] || !errors[0].datapoints || !ops[0].datapoints || (errors[0].datapoints.length != ops[0].datapoints.length)) {
      return [];
    }
  
    let timeMap = {};
    // make a map of moment ISO timestamps
    errors[0].datapoints.forEach((p) => {
      // store error count in 0
      // store original moment object in 1
      timeMap[p[1].format()] = [p[0], p[1]];
    });

    ops[0].datapoints.forEach((p) => {
      let timestamp = p[1].format();
      // retrieve corresponding error count value from timeMap
      let curr = timeMap[timestamp]; // curr[0] = error count, curr[1] is original moment object
      // only do math if the points exist & are non-zero
      let errCount = curr[0];
      if (!errCount) {
        return;
      }
      let opsCount = p[0];
      if (errCount == 0 || opsCount == 0) {
        timeMap[timestamp] = [0, curr[1]];
      } else {
        let res = (errCount / opsCount)*100;
        timeMap[timestamp] = [res, curr[1]];
      }
    });

    let datapoints = Object.keys(timeMap).map((k) => {
      // restore moment object
      let v = timeMap[k];
      return [v[0], v[1]];
    });

    return [{
      target: name,
      datapoints,
    }];
  }

  extractPercentiles(percentiles) {
    if (!percentiles) {
      return [];
    }
    return (percentiles)
      .toString()
      .split(",")
      .map(percentile => percentile.replace(/(^\s+|\s+$)/g,''))
      .filter(percentile => percentile);
  }
}
