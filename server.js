require("dotenv").config();
const { decryptAES, decodeBase64, atuwokzDecode } = require("./decrypter");
const express = require("express");
const cors = require("cors");
const sql = require("mssql");
const compression = require("compression");
const app = express();
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(compression());
const NodeCache = require("node-cache");
const myCache = new NodeCache();
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  options: {
    trustServerCertificate: true,
  },
};
clearAllCache(); //-delete all cache ketika di nyalakan
function clearAllCache() {
  myCache.flushAll();
  console.log("All cache has been cleared.");
}

//-- untuk debug tinggal panggil
function writeLog(message) {
  const timestamp = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync("log.txt", logMessage, { encoding: "utf8" });
}
async function retryOperation(operation, retries = 10000, delay = 10000) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await operation();
    } catch (error) {
      attempt++;
      console.error(
        `Operation failed (attempt ${attempt}/${retries}): ${error.message}`
      );
      if (attempt >= retries) {
        throw new Error(
          `Operation failed after ${retries} attempts: ${error.message}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

let connectionPool;
let sanitizedTableNamesCache = null;
let floorTableMap = null;

async function initializeConnectionPool(retries = 5, delay = 3000) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      connectionPool = await sql.connect(dbConfig);
      console.log("Database connected and connection pool created.");
      await initializeTableCache();
      return;
    } catch (err) {
      attempt++;
      console.error(
        `Database connection failed. Attempt: ${attempt}. Retries left: ${
          retries - attempt
        }. Error: ${err.message}`
      );
      if (attempt >= retries) {
        console.error("Max retries reached. Could not establish a connection.");
        break;
      }
      console.log(`Retrying in ${delay / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

//initializeTableCache for lantai + dashboard
async function initializeTableCache() {
  floorTableMap = {
    lantai1: "tbl_lantai_1",
    lantai1_annex: "tbl_lantai_1_annex",
    lantai2: "tbl_lantai_2",
    lantai2_annex: "tbl_lantai_2_annex",
    lantai3: "tbl_lantai_3",
    lantai3_annex: "tbl_lantai_3_annex",
    lantai4: "tbl_lantai_4",
    lantai5: "tbl_lantai_5",
    lantai6: "tbl_lantai_6",
    lantai7: "tbl_lantai_7",
    lantai8: "tbl_lantai_8",
    lantaiEksternal: "tbl_eksternal",
    lantaiGround: "tbl_lantai_ground",
  };
  try {
    const queries = Object.entries(floorTableMap).map(([key, tableName]) => {
      return `SELECT '${key}' AS floor, no_kWh_Meter, nama_kWh_Meter FROM ${tableName}`;
    });
    const combinedQuery = queries.join(" UNION ALL ");
    const result = await connectionPool.request().query(combinedQuery);
    const kwhMeters = result.recordset;
    sanitizedTableNamesCache = Array.from(
      new Set(
        kwhMeters.map((meter) => {
          const sanitizedName = meter.nama_kWh_Meter.replace(
            /[^a-zA-Z0-9_]/g,
            "_"
          );
          return `tbl_log_${sanitizedName}`;
        })
      )
    );
  } catch (err) {
    console.error("Failed to initialize table cache:", err.message);
    throw err;
  }
}
//---------START ENDPOINT "DASHOARD" (perhitungan done kan?)
async function calculateDashboard() {
  try {
    const request = new sql.Request(connectionPool);
    const result = await retryOperation(async () =>
      request.query(
        `SELECT TOP 1 emission_factor, lbwp, wbp, total_cost_limit, kvarh
        FROM tbl_set_value
        ORDER BY id DESC`
      )
    );
    if (!result.recordset.length) {
      const errorData = {
        success: false,
        message: "Configuration data not found in the database.",
      };
      myCache.set("dashboardData", errorData);
      return;
    }
    const {
      emission_factor,
      lbwp,
      wbp,
      total_cost_limit,
      kvarh,
    } = result.recordset[0];
    const EMISSION_FACTOR = parseFloat(emission_factor);
    const TARIFFS = {
      LWBP: parseFloat(lbwp),
      WBP: parseFloat(wbp),
      kvarh: parseFloat(kvarh),
    };
    const totalCostLimit = parseFloat(total_cost_limit);
    const thresholds = {
      perMonth: totalCostLimit / (TARIFFS.LWBP * 0.7917 + TARIFFS.WBP * 0.2083),
    };
    thresholds.perDay = thresholds.perMonth / 30;
    thresholds.perHour = thresholds.perDay / 24;
    thresholds.perMinute = thresholds.perHour / 60;
    thresholds.perYear = thresholds.perMonth * 12;

    const calculateDerivedThresholds = (value) => ({
      energyConsume: value,
      energyConsumeAktual: value * 1.6,
      emission: value * EMISSION_FACTOR,
    });

    const thresholdData = {
      perMinute: calculateDerivedThresholds(thresholds.perMinute),
      perHour: calculateDerivedThresholds(thresholds.perHour),
      perDay: calculateDerivedThresholds(thresholds.perDay),
      perMonth: calculateDerivedThresholds(thresholds.perMonth),
      perYear: calculateDerivedThresholds(thresholds.perYear),
    };

    if (!sanitizedTableNamesCache) await initializeTableCache();
    const timestamp = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    console.log(`[Running Calculate Dashboard -- [${timestamp}]`);
    const logs = [];

    const getElectricityTariff = (dateTime, pfAvg) => {
      const hour = new Date(dateTime).getHours();
      let tariff = hour >= 23 || hour < 17 ? TARIFFS.LWBP : TARIFFS.WBP;
      if (pfAvg < 0.85) {
        tariff += TARIFFS.kvarh;
      }
      return tariff;
    };

    await Promise.all(
      sanitizedTableNamesCache.map((tableName) =>
        retryOperation(
          () =>
            new Promise((resolve, reject) => {
              const request = new sql.Request(connectionPool);
              request.stream = true;
              request.query(
                `SELECT CONVERT(VARCHAR(19), log_waktu, 120) AS log_waktu, v_avg, I_avg, kVA, kW, kVArh, PF_avg, no_kWh_Meter
                FROM ${tableName}
                ORDER BY log_waktu DESC`
              );
              request.on("row", (row) => {
                const decryptedRow = { ...row };
                ["kVA", "kW", "kVArh", "PF_avg", "v_avg", "I_avg"].forEach(
                  (field) => {
                    try {
                      decryptedRow[field] = parseFloat(
                        atuwokzDecode(decodeBase64(decryptAES(row[field])))
                      );
                    } catch {
                      decryptedRow[field] = 0;
                    }
                  }
                );

                // ADD: Hitung cost di level log
                const PF_avg = parseFloat(decryptedRow.PF_avg || 0);
                const energyConsume = parseFloat(decryptedRow.kW || 0) / 60; 
                const energyConsumeActual = energyConsume * 1.6;
                const tariff = getElectricityTariff(row.log_waktu, PF_avg);
                const numericCost =
                  energyConsumeActual * tariff +
                  (PF_avg < 0.85 ? energyConsumeActual * TARIFFS.kvarh : 0);

                decryptedRow.energyConsume = energyConsume;
                decryptedRow.energyConsumeActual = energyConsumeActual;
                decryptedRow.numericCost = numericCost; // ADD: simpan cost per log
                logs.push(decryptedRow);
              });
              request.on("error", (err) => reject(err));
              request.on("done", () => resolve());
            })
        )
      )
    );
    const groupAndAggregateLogs = (granularity) => {
      const formatTimeKey = (log, granularity) => {
        const date = new Date(log.log_waktu);
        const pad = (num) => String(num).padStart(2, "0");
        const formattedTime = `${date.getFullYear()}-${pad(
          date.getMonth() + 1
        )}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
          date.getMinutes()
        )}:${pad(date.getSeconds())}`;

        switch (granularity) {
          case "minute":
            return formattedTime.slice(0, 16);
          case "hour":
            return formattedTime.slice(0, 13);
          case "day":
            return formattedTime.slice(0, 10);
          case "month":
            return formattedTime.slice(0, 7);
          case "year":
            return formattedTime.slice(0, 4);
          default:
            throw new Error("Invalid granularity");
        }
      };

      const groupedLogs = logs.reduce((acc, log) => {
        const key = formatTimeKey(log, granularity);
        acc[key] = acc[key] || [];
        acc[key].push(log);
        return acc;
      }, {});

      return Object.entries(groupedLogs).map(([time, logGroup]) => {
        const totals = logGroup.reduce(
          (sum, log) => {
            sum.kW += log.kW;
            sum.kVA += log.kVA;
            sum.kVArh += log.kVArh;
            sum.v_avg += log.v_avg;
            sum.I_avg += log.I_avg;
            sum.PF_avg += log.PF_avg;
            sum.cost += log.numericCost; // ADD: Jumlahkan cost langsung dari numericCost per log
            sum.energyConsume += log.energyConsume; // ADD: agar emission tetap sesuai
            sum.energyConsumeActual += log.energyConsumeActual; 
            return sum;
          },
          { kW: 0, kVA: 0, kVArh: 0, v_avg: 0, I_avg: 0, PF_avg: 0, cost: 0, energyConsume:0, energyConsumeActual:0 }
        );

        const count = logGroup.length;
        const energyConsume = totals.energyConsume;
        const energyConsumeActual = totals.energyConsumeActual;
        const energyReactive = totals.kVArh / 60;
        const energyApparent = totals.kVA / 60;
        const emission = energyConsumeActual * EMISSION_FACTOR;
        // Sekarang cost sudah diakumulasi dari numericCost per log
        const totalCost = totals.cost;

        return {
          time,
          V_AVG: totals.v_avg / count,
          I_AVG: totals.I_avg / count,
          PF_AVG: totals.PF_avg / count,
          energyConsume,
          energyConsumeActual,
          energyApparent,
          energyReactive,
          emission,
          cost: new Intl.NumberFormat("id-ID", {
            style: "currency",
            currency: "IDR",
          }).format(totalCost),
        };
      });
    };

    const minuteData = groupAndAggregateLogs("minute");
    const hourlyData = groupAndAggregateLogs("hour");
    const dailyData = groupAndAggregateLogs("day");
    const monthlyData = groupAndAggregateLogs("month");
    const yearlyData = groupAndAggregateLogs("year");
    const AC_AREA = 13199.79;

    const calculateEEI = (data) =>
      data.map((entry) => ({
        ...entry,
        EEI: entry.energyConsumeActual / AC_AREA,
      }));

    const dashboardData = {
      success: true,
      data: {
        thresholds: thresholdData,
        minuteData: calculateEEI(minuteData),
        hourlyData: calculateEEI(hourlyData),
        dailyData: calculateEEI(dailyData),
        monthlyData: calculateEEI(monthlyData),
        yearlyData: calculateEEI(yearlyData),
      },
    };
    myCache.set("dashboardData", dashboardData);
  } catch (err) {
    console.error(err);
    const errorData = {
      success: false,
      message: `Error processing data: ${err.message}`,
    };
    myCache.set("dashboardData", errorData);
  }
}

app.get("/dashboard", async (req, res) => {
  try {
    const cachedData = myCache.get("dashboardData");
    if (cachedData) {
      // Jika data ada di cache, kembalikan data dari cache
      return res.json(cachedData);
    } else {
      // Jika tidak ada di cache, coba jalankan perhitungan sekali lalu kembalikan hasilnya
      await calculateDashboard();
      const freshData = myCache.get("dashboardData");
      if (freshData) {
        return res.json(freshData);
      } else {
        return res.status(500).json({
          success: false,
          message: "Error retrieving data.",
        });
      }
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: `Error: ${err.message}`,
    });
  }
});

//---------START ENDPOINT "LANTAI" (perhitungan done kan?)
async function calculateLantai(lantai) {
  const request = new sql.Request(connectionPool);
  if (!floorTableMap[lantai]) {
    return {
      success: false,
      message: "Lantai tidak ditemukan.",
    };
  }

  const tableName = floorTableMap[lantai];
  const result = await retryOperation(async () =>
    request.query(
      `SELECT no_kWh_Meter, nama_kWh_Meter, ruangan, no_panel
       FROM ${tableName}
       ORDER BY no_panel ASC`
    )
  );

  const meterData = result.recordset;

  if (!meterData.length) {
    return {
      success: false,
      message: "Data tidak ditemukan untuk lantai ini.",
    };
  }

  // Ambil konfigurasi dari tbl_set_value
  const configResult = await retryOperation(async () =>
    request.query(`
      SELECT TOP 1 emission_factor, lbwp, wbp, total_cost_limit, kvarh
      FROM tbl_set_value
      ORDER BY id DESC
    `)
  );

  if (!configResult.recordset.length) {
    return {
      success: false,
      message: "Konfigurasi data tidak ditemukan di database.",
    };
  }

  const {
    emission_factor,
    lbwp,
    wbp,
    total_cost_limit,
    kvarh,
  } = configResult.recordset[0];

  // Parsing data konfigurasi
  const EMISSION_FACTOR = parseFloat(emission_factor);
  const TARIFFS = {
    LWBP: parseFloat(lbwp),
    WBP: parseFloat(wbp),
    kvarh: parseFloat(kvarh),
  };
  const totalCostLimit = parseFloat(total_cost_limit);

  // Grup data kWh meter berdasarkan ruangan
  const ruanganKwhMeters = meterData.reduce((acc, meter) => {
    const ruangan = meter.ruangan;
    if (!acc[ruangan]) acc[ruangan] = [];
    acc[ruangan].push(meter);
    return acc;
  }, {});

  // Hitung threshold untuk setiap ruangan
  const ruanganThresholds = {};
  Object.keys(ruanganKwhMeters).forEach((ruangan) => {
    const jumlahKwhMeterDiRuangan = ruanganKwhMeters[ruangan].length;
    const totalKwhMeter = 64;
    const thresholdPerMonth =
      (totalCostLimit / (TARIFFS.LWBP * 0.7917 + TARIFFS.WBP * 0.2083)) *
      (jumlahKwhMeterDiRuangan / totalKwhMeter);
    const thresholdPerDay = thresholdPerMonth / 30;
    const thresholdPerYear = thresholdPerMonth * 12;

    const calculateDerivedThresholds = (value) => ({
      energyConsume: value,
      energyConsumeAktual: value * 1.6,
      emission: value * EMISSION_FACTOR,
    });

    ruanganThresholds[ruangan] = {
      perDay: calculateDerivedThresholds(thresholdPerDay),
      perMonth: calculateDerivedThresholds(thresholdPerMonth),
      perYear: calculateDerivedThresholds(thresholdPerYear),
    };
  });

  const getElectricityTariff = (dateTime, pfAvg) => {
    const hour = new Date(dateTime).getHours();
    let tariff = hour >= 23 || hour < 17 ? TARIFFS.LWBP : TARIFFS.WBP;
    if (pfAvg < 0.85) {
      tariff += TARIFFS.kvarh;
    }
    return tariff;
  };
  // Fungsi untuk mendekripsi kolom log
  const decryptLogFields = (row) => {
    const decryptedLog = { ...row };
    [
      "v_avg",
      "I_avg",
      "kVA",
      "kW",
      "kVArh",
      "PF_avg",
      "v_L1",
      "v_L2",
      "v_L3",
    ].forEach((field) => {
      try {
        decryptedLog[field] = parseFloat(
          atuwokzDecode(decodeBase64(decryptAES(row[field])))
        );
      } catch {
        decryptedLog[field] = 0;
      }
    });
    return decryptedLog;
  };

  const logs = {};
  await Promise.all(
    Object.keys(ruanganKwhMeters).map(async (ruangan) => {
      logs[ruangan] = [];
      await Promise.all(
        ruanganKwhMeters[ruangan].map(async (meter) => {
          const sanitizedTableName = `tbl_log_${meter.nama_kWh_Meter.replace(
            /[^a-zA-Z0-9_]/g,
            "_"
          )}`;

          try {
            const logResult = await retryOperation(async () =>
              request.query(`
                SELECT CONVERT(VARCHAR(19), log_waktu, 120) AS log_waktu, v_avg, I_avg, kVA, kW, kVArh, PF_avg, v_L1, v_L2, v_L3
                FROM ${sanitizedTableName}
                WHERE no_kWh_Meter = ${meter.no_kWh_Meter}
                ORDER BY log_waktu DESC
              `)
            );
            logResult.recordset.forEach((log) => {
              const decryptedLog = decryptLogFields(log);
              // Hitung cost di level minute
              const PF_avg = parseFloat(decryptedLog.PF_avg || 0);
              const energyConsume = parseFloat(decryptedLog.kW || 0) / 60; // per minute
              const energyConsumeActual = energyConsume * 1.6;
              const tariff = getElectricityTariff(log.log_waktu, PF_avg);
              const logCost =
                energyConsumeActual * tariff +
                (PF_avg < 0.85 ? energyConsumeActual * TARIFFS.kvarh : 0);

              logs[ruangan].push({
                ...decryptedLog,
                no_kWh_Meter: meter.no_kWh_Meter,
                nama_kWh_Meter: meter.nama_kWh_Meter,
                numericEnergyConsume: energyConsume,
                numericEnergyConsumeActual: energyConsumeActual,
                numericCost: logCost,
              });
            });
          } catch (err) {
            console.error(
              `Failed to fetch logs for table: ${sanitizedTableName}`,
              err.message
            );
          }
        })
      );
    })
  );


  // Fungsi Moving Average
  function predictMonthlyCostWithMovingAverage(logGroup, year, month, windowSize = 7) {
    // Kumpulkan biaya harian
    const dailyCosts = {};
    for (const log of logGroup) {
      const date = new Date(log.log_waktu);
      const day = date.getDate();
      if (!dailyCosts[day]) dailyCosts[day] = 0;
      dailyCosts[day] += log.numericCost;
    }

    const daysInMonth = new Date(year, month, 0).getDate();
    const knownDays = Object.keys(dailyCosts)
      .map(d => parseInt(d,10))
      .sort((a,b) => a-b);

    if (knownDays.length === 0) {
      // Tidak ada data sama sekali
      return 0;
    }

    // Hitung total biaya yang sudah diketahui
    const totalKnownCost = knownDays.reduce((sum, d) => sum + dailyCosts[d], 0);
    const daysElapsed = knownDays.length;
    const daysRemaining = daysInMonth - daysElapsed;
    if (daysElapsed === 0) {
      return 0; 
    }

    // Ambil N hari terakhir
    const recentDays = knownDays.slice(-windowSize);
    const recentCosts = recentDays.map(d => dailyCosts[d]);
    const movingAverageCost = recentCosts.reduce((a,b) => a+b,0) / recentCosts.length;

    // Prediksi total sebulan = totalKnownCost + (movingAverageCost * daysRemaining)
    const predictedTotal = totalKnownCost + (movingAverageCost * daysRemaining);
    return predictedTotal;
  }


  const groupAndAggregateLogs = (logData, granularity) => {
    const formatTimeKey = (log, granularity) => {
      const date = new Date(log.log_waktu);
      const pad = (num) => String(num).padStart(2, "0");
      const formattedTime = `${date.getFullYear()}-${pad(
        date.getMonth() + 1
      )}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
        date.getMinutes()
      )}:${pad(date.getSeconds())}`;

      switch (granularity) {
        case "minute":
          return formattedTime.slice(0, 16);
        case "hour":
          return formattedTime.slice(0, 13);
        case "day":
          return formattedTime.slice(0, 10);
        case "month":
          return formattedTime.slice(0, 7);
        case "year":
          return formattedTime.slice(0, 4);
        default:
          throw new Error("Invalid granularity");
      }
    };

    const groupedLogs = logData.reduce((acc, log) => {
      const key = formatTimeKey(log, granularity);
      acc[key] = acc[key] || [];
      acc[key].push(log);
      return acc;
    }, {});

    return Object.entries(groupedLogs).map(([time, logGroup]) => {
      const totals = logGroup.reduce(
        (sum, log) => {
          sum.kW += parseFloat(log.kW || 0);
          sum.kVA += parseFloat(log.kVA || 0);
          sum.kVArh += parseFloat(log.kVArh || 0);
          sum.v_avg += parseFloat(log.v_avg || 0);
          sum.I_avg += parseFloat(log.I_avg || 0);
          sum.PF_avg += parseFloat(log.PF_avg || 0);
          sum.v_L1 += parseFloat(log.v_L1 || 0);
          sum.v_L2 += parseFloat(log.v_L2 || 0);
          sum.v_L3 += parseFloat(log.v_L3 || 0);
          sum.cost += log.numericCost; 
          return sum;
        },
        {
          kW: 0,
          kVA: 0,
          kVArh: 0,
          v_avg: 0,
          I_avg: 0,
          PF_avg: 0,
          v_L1: 0,
          v_L2: 0,
          v_L3: 0,
          cost: 0,
        }
      );

      const count = logGroup.length;
      const energyConsume = totals.kW / 60;
      const energyConsumeActual = energyConsume * 1.6;
      const energyReactive = totals.kVArh / 60;
      const energyApparent = totals.kVA / 60;
      const emission = energyConsumeActual * EMISSION_FACTOR;
      const totalCost = totals.cost;

      let predictedCost = 0;

      if (granularity === "month") {
        const [yearStr, monthStr] = time.split("-");
        const year = parseInt(yearStr,10);
        const month = parseInt(monthStr,10);

        // Gunakan moving average untuk prediksi
        predictedCost = predictMonthlyCostWithMovingAverage(logGroup, year, month, 7);
      }

      const result = {
        time,
        V_AVG: totals.v_avg / count,
        I_AVG: totals.I_avg / count,
        PF_AVG: totals.PF_avg / count,
        R_AVG: totals.v_L1 / count,
        S_AVG: totals.v_L2 / count,
        T_AVG: totals.v_L3 / count,
        energyConsume,
        energyConsumeActual,
        energyApparent,
        energyReactive,
        emission,
        cost: new Intl.NumberFormat("id-ID", {
          style: "currency",
          currency: "IDR",
        }).format(totalCost),
      };

      if (granularity === "month") {
        result.predictedCost = new Intl.NumberFormat("id-ID", {
          style: "currency",
          currency: "IDR",
        }).format(predictedCost);
      }

      return result;
    });
  };

  const ruanganData = Object.keys(logs).reduce((acc, ruangan) => {
    const logData = logs[ruangan];

    acc[ruangan] = {
      thresholds: ruanganThresholds[ruangan],
      minuteData: groupAndAggregateLogs(logData, "minute"),
      hourlyData: groupAndAggregateLogs(logData, "hour"),
      dailyData: groupAndAggregateLogs(logData, "day"),
      monthlyData: groupAndAggregateLogs(logData, "month"),
      yearlyData: groupAndAggregateLogs(logData, "year"),
    };

    return acc;
  }, {});

  return {
    success: true,
    data: { Ruangan: ruanganData },
  };
}

async function runFloorCalculations() {
  if (!floorTableMap) return;
  const lantaiKeys = Object.keys(floorTableMap);
  for (const lantaiKey of lantaiKeys) {
    try {
      const data = await calculateLantai(lantaiKey);
      myCache.set(`olahData_${lantaiKey}`, data);
      const timestamp = new Date().toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      console.log(`[Running Calculate LANTAI --${lantaiKey} -- [${timestamp}]`);
    } catch (err) {
      const timestamp = new Date().toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      console.error(
        `Error calculating data for ${lantaiKey}:`,
        err, 
        ` -- [${timestamp}]`
      );
      // writeLog(`Error calculating data for ${lantaiKey}: ${err.message}`);
      myCache.set(`olahData_${lantaiKey}`, {
        success: false,
        message: `Error processing data: ${err.message}-- [${timestamp}]`,
      });
    }
  }
}

// Endpoint untuk mengambil data olahan per lantai
app.get("/olahData/:lantai", async (req, res) => {
  const { lantai } = req.params;
  try {
    const cachedData = myCache.get(`olahData_${lantai}`);
    if (cachedData) {
      return res.json(cachedData);
    } else {
      const data = await calculateLantai(lantai);
      myCache.set(`olahData_${lantai}`, data);
      return res.json(data);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: `Error: ${err.message}`,
    });
  }
});

app.get("/debug/cache/:key", (req, res) => {
  const { key } = req.params;
  const cachedData = myCache.get(key);
  res.json(cachedData || { success: false, message: "No data found for key" });
});

app.get("/managementMonitoring", async (req, res) => {
  try {
    const lantaiList = [
      "lantai1",
      "lantai1_annex",
      "lantai2",
      "lantai2_annex",
      "lantai3",
      "lantai3_annex",
      "lantai4",
      "lantai5",
      "lantai6",
      "lantai7",
      "lantai8",
      "lantaiEksternal",
      "lantaiGround",
    ];

    const results = [];
    let totalEmissionOverall = 0;
    let predictedEmissionOverall = 0; 

    // Fungsi untuk menghitung prediksi emisi bulanan dari dailyData dengan sisa hari.
    // Contoh: jika hanya ada data tgl 7 dan 8, maka:
    // totalEmissionDaily = emisi dari tgl 7+8
    // avgDailyEmission = totalEmissionDaily / 2
    // sisaHari = daysInMonth - hariTerakhirData (misal 31 - 8 = 23 hari)
    // predictedEmission = totalEmissionDaily + (avgDailyEmission * sisaHari)
    function predictMonthlyEmissionFromDailyData(dailyData) {
      if (!dailyData || dailyData.length === 0) return 0;

      dailyData.sort((a, b) => new Date(a.time) - new Date(b.time));

      const firstDate = new Date(dailyData[0].time);
      const lastDate = new Date(dailyData[dailyData.length - 1].time);
      const year = firstDate.getFullYear();
      const month = firstDate.getMonth() + 1;
      const daysInMonth = new Date(year, month, 0).getDate();

      const totalEmissionDaily = dailyData.reduce((sum, d) => sum + (parseFloat(d.emission) || 0), 0);
      const dataDays = dailyData.length;
      if (dataDays === 0) return 0;

      const avgDailyEmission = totalEmissionDaily / dataDays;
      const lastDayOfData = lastDate.getDate();

      // Hitung sisa hari dalam bulan
      const remainingDays = daysInMonth - lastDayOfData;

      // Prediksi = total emisi yang sudah ada + rata-rata harian * sisa hari
      const predictedEmission = totalEmissionDaily + (avgDailyEmission * remainingDays);
      return predictedEmission;
    }

    for (const lantai of lantaiList) {
      // writeLog(`Processing ${lantai}...`);
      const cachedData = myCache.get(`olahData_${lantai}`);
      if (!cachedData) {
        // writeLog(`Cache not found for ${lantai}, running calculations.`);
        await runFloorCalculations();
      }

      const updatedCachedData = myCache.get(`olahData_${lantai}`);
      if (!updatedCachedData?.data?.Ruangan) {
        // writeLog(`No data found for ${lantai}, setting values to 0.`);
        results.push({
          lantai,
          energyConsume: 0,
          energyConsumeActual: 0,
          cost: 0,
          emission: 0,
          predictedCost: 0,
        });
        continue;
      }

      let totalEnergyConsume = 0;
      let totalEnergyConsumeActual = 0;
      let totalCostThisMonth = 0;
      let totalEmission = 0;            // Emission dari monthlyData (tetap seperti code lama)
      let totalPredictedCost = 0;
      let totalPredictedEmissionForFloor = 0;  // predictedEmission dari dailyData

      Object.entries(updatedCachedData.data.Ruangan).forEach(([ruangan, data]) => {
        if (data?.monthlyData?.length > 0) {
          // Sort monthlyData berdasarkan waktu
          data.monthlyData.sort((a, b) => new Date(a.time) - new Date(b.time));

          // Ambil data terbaru (latestData) dari monthlyData untuk emission dan cost
          const latestData = data.monthlyData.reduce((latest, current) => {
            return new Date(current.time) > new Date(latest.time) ? current : latest;
          });

          if (latestData) {
            const { energyConsume, energyConsumeActual, cost, emission, predictedCost } = latestData;
            const parsedCost = parseFloat(
              cost.replace(/Rp|\.|,/g, (match) => (match === "," ? "." : ""))
            );
            const parsedPredictedCost = parseFloat(
              predictedCost?.replace(/Rp|\.|,/g, (match) => (match === "," ? "." : "")) || 0
            );

            totalEnergyConsume += parseFloat(energyConsume || 0);
            totalEnergyConsumeActual += parseFloat(energyConsumeActual || 0);
            totalCostThisMonth += parsedCost;
            totalEmission += parseFloat(emission || 0); // Masih dari monthlyData
            totalPredictedCost += parsedPredictedCost;

            // writeLog(
            //   `Lantai: ${lantai}, Ruangan: ${ruangan}, Time: ${latestData.time}, Energy Consume: ${energyConsume}, Energy Consume Actual: ${energyConsumeActual}, Cost: ${cost}, Emission: ${emission}, Predicted Cost: ${predictedCost}, Parsed Cost: ${parsedCost}, Parsed Predicted Cost: ${parsedPredictedCost}, Total Cost So Far: ${totalCostThisMonth}, Total Emission So Far: ${totalEmission}`
            // );
          }
        }

        // Prediksi emisi sekarang ambil dari dailyData dengan menggunakan sisa hari
        if (data?.dailyData?.length > 0) {
          const predictedEmissionForThisRoom = predictMonthlyEmissionFromDailyData(data.dailyData);
          totalPredictedEmissionForFloor += predictedEmissionForThisRoom;
          // writeLog(
          //   `Predicted Emission (from dailyData) for lantai: ${lantai}, Ruangan: ${ruangan} = ${predictedEmissionForThisRoom}`
          // );
        } else {
          // Jika tidak ada dailyData, prediksi 0 untuk ruangan ini
          // writeLog(`No dailyData for prediction in lantai: ${lantai}, Ruangan: ${ruangan}`);
        }
      });

      results.push({
        lantai,
        energyConsume: totalEnergyConsume,
        energyConsumeActual: totalEnergyConsumeActual,
        cost: totalCostThisMonth,
        emission: totalEmission,
        predictedCost: totalPredictedCost,
      });

      totalEmissionOverall += totalEmission;
      predictedEmissionOverall += totalPredictedEmissionForFloor; // predicted total dari dailyData

      // writeLog(
      //   `Final Results for ${lantai}: Total Energy Consume: ${totalEnergyConsume}, Total Energy Consume Actual: ${totalEnergyConsumeActual}, Total Cost: ${totalCostThisMonth}, Total Emission: ${totalEmission}, Predicted Emission (Floor): ${totalPredictedEmissionForFloor}, Total Predicted Cost: ${totalPredictedCost}`
      // );
    }

    const sortedByEnergyConsume = [...results].sort((a, b) => b.energyConsume - a.energyConsume);
    const sortedByEnergyConsumeActual = [...results].sort((a, b) => b.energyConsumeActual - a.energyConsumeActual);
    const sortedByCost = [...results].sort((a, b) => b.cost - a.cost);

    const totalCostOverall = sortedByCost.reduce((sum, item) => sum + item.cost, 0);
    // writeLog(`Total Cost Overall: ${totalCostOverall}`);

    const totalPredictedCostOverall = results.reduce((sum, item) => sum + item.predictedCost, 0);
    // writeLog(`Total Predicted Cost Overall: ${totalPredictedCostOverall}`);

    const formattedTotalCost = new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
    }).format(totalCostOverall);

    const formattedTotalPredictedCost = new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
    }).format(totalPredictedCostOverall);

    const totalCostPerLantai = {};
    sortedByCost.forEach((item) => {
      totalCostPerLantai[item.lantai] = new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
      }).format(item.cost);
    });

    const totalEnergyConsumeLantai = {};
    const energyConsumeActualLantai = {};
    sortedByEnergyConsume.forEach((item) => {
      totalEnergyConsumeLantai[item.lantai] = item.energyConsume;
    });
    sortedByEnergyConsumeActual.forEach((item) => {
      energyConsumeActualLantai[item.lantai] = item.energyConsumeActual;
    });

    // writeLog(`Final Total Cost Overall: ${formattedTotalCost}`);
    // writeLog(`Final Total Predicted Cost Overall: ${formattedTotalPredictedCost}`);
    // writeLog(`Final Total Emission Overall: ${totalEmissionOverall}`);

    // Perhitungan totalCostLastMonth dan totalCostLastYear
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1;
    const currentYear = currentDate.getFullYear();

    const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const lastMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;
    const lastYear = currentYear - 1;

    let totalCostLastMonth = 0;
    let totalCostLastYear = 0;

    for (const lantai of lantaiList) {
      const cachedData = myCache.get(`olahData_${lantai}`);
      if (cachedData?.data?.Ruangan) {
        Object.entries(cachedData.data.Ruangan).forEach(([ruangan, data]) => {
          // Total cost untuk bulan lalu
          if (data?.monthlyData?.length > 0) {
            data.monthlyData.forEach((entry) => {
              const [entryYear, entryMonthStr] = entry.time.split("-");
              const entryYearNum = parseInt(entryYear);
              const entryMonthNum = parseInt(entryMonthStr);

              if (entryYearNum === lastMonthYear && entryMonthNum === lastMonth) {
                const parsedCost = parseFloat(
                  entry.cost.replace(/Rp|\.|,/g, (match) => (match === "," ? "." : ""))
                );
                totalCostLastMonth += parsedCost;
              }
            });
          }

          // Total cost untuk tahun lalu
          if (data?.yearlyData?.length > 0) {
            const yearlyEntry = data.yearlyData.find(
              (ye) => parseInt(ye.time) === lastYear
            );
            if (yearlyEntry) {
              const parsedCost = parseFloat(
                yearlyEntry.cost.replace(/Rp|\.|,/g, (match) => (match === "," ? "." : ""))
              );
              totalCostLastYear += parsedCost;
            }
          }
        });
      }
    }
    // writeLog(`Total Cost Last Month: ${totalCostLastMonth}`);
    // writeLog(`Total Cost Last Year: ${totalCostLastYear}`);

    const formattedTotalCostLastMonth = new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
    }).format(totalCostLastMonth);

    const formattedTotalCostLastYear = new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
    }).format(totalCostLastYear);

    const totalSavingCostLastYearValue = totalCostLastYear - totalCostOverall;
    // writeLog(`Raw Total Saving Cost Last Year: ${totalSavingCostLastYearValue}`);

    const formattedTotalSavingCostLastYear = new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
    }).format(totalSavingCostLastYearValue);

    // writeLog(`Total Saving Cost Last Year (Formatted): ${formattedTotalSavingCostLastYear}`);

    const monthMapping = {
      1: "Jan",
      2: "Feb",
      3: "Mar",
      4: "Apr",
      5: "May",
      6: "Jun",
      7: "Jul",
      8: "Aug",
      9: "Sep",
      10: "Oct",
      11: "Nov",
      12: "Dec",
    };

    const totalCostMonthlyChart = {
      Dec: 0,
      Nov: 0,
      Oct: 0,
      Sep: 0,
      Aug: 0,
      Jul: 0,
      Jun: 0,
      May: 0,
      Apr: 0,
      Mar: 0,
      Feb: 0,
      Jan: 0,
    };

    for (const lantai of lantaiList) {
      const cachedData = myCache.get(`olahData_${lantai}`);
      if (cachedData?.data?.Ruangan) {
        Object.entries(cachedData.data.Ruangan).forEach(([ruangan, data]) => {
          if (data?.monthlyData?.length > 0) {
            data.monthlyData.forEach((entry) => {
              const [entryYear, entryMonthStr] = entry.time.split("-");
              const entryMonthNum = parseInt(entryMonthStr, 10);
              const monthName = monthMapping[entryMonthNum];
              if (monthName) {
                const parsedCost = parseFloat(
                  entry.cost.replace(/Rp|\.|,/g, (match) => (match === "," ? "." : ""))
                );
                if (!isNaN(parsedCost)) {
                  totalCostMonthlyChart[monthName] += parsedCost;
                }
              }
            });
          }
        });
      }
    }

    Object.keys(totalCostMonthlyChart).forEach((month) => {
      if (totalCostMonthlyChart[month] === 0) {
        totalCostMonthlyChart[month] = null;
      } else {
        totalCostMonthlyChart[month] = new Intl.NumberFormat("id-ID", {
          style: "currency",
          currency: "IDR",
        }).format(totalCostMonthlyChart[month]);
      }
    });

    // Gunakan predictedEmissionOverall yang didapat dari dailyData untuk predictedEmission
    return res.status(200).json({
      success: true,
      data: {
        totalEnergyConsumeLantai,
        energyConsumeActualLantai,
        totalCostMonthlyChart,
        totalCostPerLantai,
        totalCostThisMonth: formattedTotalCost,
        emission: totalEmissionOverall,          // dari monthlyData seperti semula
        predictedEmission: predictedEmissionOverall, // prediksi menggunakan sisa hari di bulan
        predictedCost: formattedTotalPredictedCost,
        totalCostLastMonth: formattedTotalCostLastMonth,
        totalCostLastYear: formattedTotalCostLastYear,
        totalSavingCostLastYear: formattedTotalSavingCostLastYear,
      },
    });
  } catch (error) {
    // writeLog(`Error in /managementMonitoring: ${error.message}`);
    console.error("Error in /managementMonitoring:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

//--ENDPOINT emissionMonitoring (belum done)
app.get("/emissionMonitoring", async (req, res) => {
  try {
    const request = new sql.Request(connectionPool);
    const result = await request.query(`
      SELECT TOP 1 
        emission_factor, 
        lbwp, 
        wbp,  
        total_cost_limit
      FROM tbl_set_value
      ORDER BY id DESC
    `);

    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Data konfigurasi tidak ditemukan di database.",
      });
    }

    const config = result.recordset[0];
    const EMISSION_FACTOR = parseFloat(config.emission_factor);

    if (!sanitizedTableNamesCache) {
      await initializeTableCache();
    }

    const logs = [];
    const promises = sanitizedTableNamesCache.map((tableName) => {
      return new Promise((resolve, reject) => {
        const request = new sql.Request(connectionPool);
        request.stream = true;

        request.query(`
          SELECT 
            CONVERT(VARCHAR(19), log_waktu, 120) AS log_waktu, 
            v_L1, 
            v_L2, 
            v_L3, 
            I_A1, 
            I_A2, 
            I_A3, 
            v_avg, 
            I_avg, 
            PF_avg 
          FROM ${tableName} 
          ORDER BY log_waktu DESC
        `);

        request.on("row", (row) => {
          const decryptedLog = { ...row };
          [
            "v_L1",
            "v_L2",
            "v_L3",
            "I_A1",
            "I_A2",
            "I_A3",
            "v_avg",
            "I_avg",
            "PF_avg",
          ].forEach((field) => {
            try {
              decryptedLog[field] = parseFloat(
                atuwokzDecode(decodeBase64(decryptAES(row[field])))
              );
            } catch {
              decryptedLog[field] = 0;
            }
          });
          logs.push(decryptedLog);
        });

        request.on("error", (err) => {
          console.error(`Error during query stream for ${tableName}:`, err);
          reject(err);
        });

        request.on("done", () => resolve());
      });
    });

    await Promise.all(promises);

    const groupLogsByGranularity = (logs, length) => {
      return logs.reduce((acc, log) => {
        const key = log.log_waktu.slice(0, length);
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(log);
        return acc;
      }, {});
    };

    const calculateAggregatedMetrics = (groupedLogs) => {
      return Object.entries(groupedLogs).map(([time, logs]) => {
        let totalR = 0;
        let totalS = 0;
        let totalT = 0;
        let totalIA1 = 0;
        let totalIA2 = 0;
        let totalIA3 = 0;
        let totalEnergyConsumeR = 0;
        let totalEnergyConsumeS = 0;
        let totalEnergyConsumeT = 0;
        let totalEnergyConsume = 0;
        let totalPF = 0;
        logs.forEach((log) => {
          const R_AVG = log.v_L1;
          const S_AVG = log.v_L2;
          const T_AVG = log.v_L3;
          const IA1_AVG = log.I_A1;
          const IA2_AVG = log.I_A2;
          const IA3_AVG = log.I_A3;
          const PF_AVG = log.PF_avg;

          totalR += R_AVG;
          totalS += S_AVG;
          totalT += T_AVG;
          totalIA1 += IA1_AVG;
          totalIA2 += IA2_AVG;
          totalIA3 += IA3_AVG;
          totalPF += PF_AVG;

          // Energy consumption per phase
          const powerR = (R_AVG * IA1_AVG * PF_AVG) / 1000; // kW
          const powerS = (S_AVG * IA2_AVG * PF_AVG) / 1000; // kW
          const powerT = (T_AVG * IA3_AVG * PF_AVG) / 1000; // kW

          totalEnergyConsumeR += powerR * (1 / 60); // kWh per minute
          totalEnergyConsumeS += powerS * (1 / 60); // kWh per minute
          totalEnergyConsumeT += powerT * (1 / 60); // kWh per minute

          // Total energy consumption
          const totalPower = (log.v_avg * log.I_avg * PF_AVG) / 1000; // kW
          totalEnergyConsume += totalPower * (1 / 60); // kWh per minute
        });

        const count = logs.length;

        const R_AVG = totalR / count;
        const S_AVG = totalS / count;
        const T_AVG = totalT / count;
        const IA1_AVG = totalIA1 / count;
        const IA2_AVG = totalIA2 / count;
        const IA3_AVG = totalIA3 / count;
        const PF_AVG = totalPF / count;

        const energyConsumeActual = totalEnergyConsume * 1.6; // Actual consumption adjustment
        const emission = energyConsumeActual * EMISSION_FACTOR; // Emission calculation

        // Fungsi untuk menghitung rata-rata konsumsi energi per hari
        const calculateDailyAverage = (logs, daysElapsed) => {
          if (logs.length === 0 || daysElapsed === 0) return 0; // Validasi log kosong atau daysElapsed nol
          const totalEnergy = logs.reduce(
            (acc, log) => acc + (log.energyConsume || 0),
            0
          ); // Pastikan energyConsume valid
          return totalEnergy / daysElapsed;
        };

        // Hitung jumlah hari dalam bulan
        const currentDate = new Date();
        const daysInMonth = new Date(
          currentDate.getFullYear(),
          currentDate.getMonth() + 1,
          0
        ).getDate();

        // Hitung jumlah hari unik dari data log
        const uniqueDays = logs.reduce((acc, log) => {
          const logDate = new Date(log.log_waktu).getDate();
          if (!acc.includes(logDate)) acc.push(logDate);
          return acc;
        }, []);
        const daysElapsed = uniqueDays.length || 0; // Pastikan daysElapsed minimal 0

        // Rata-rata konsumsi harian
        const energyConsume_AVG = calculateDailyAverage(logs, daysElapsed);

        // Prediksi konsumsi energi
        let predictedEnergyConsume;
        if (energyConsume_AVG > 0 && daysElapsed > 0) {
          const remainingDays = Math.max(daysInMonth - daysElapsed, 0);
          const predictedFromAvg = energyConsume_AVG * remainingDays;

          // Total prediksi = konsumsi aktual + prediksi untuk sisa hari
          predictedEnergyConsume = energyConsumeActual + predictedFromAvg;
        } else {
          // Jika data tidak cukup, gunakan konsumsi aktual sebagai prediksi dasar
          predictedEnergyConsume = energyConsumeActual;
        }

        // Pastikan prediksi tidak lebih kecil dari konsumsi aktual
        predictedEnergyConsume = Math.max(
          predictedEnergyConsume,
          energyConsumeActual
        );

        // Perhitungan konsumsi aktual disesuaikan
        const adjustmentFactor = 1.6; // Faktor penyesuaian
        const predictedEnergyConsumeActual =
          predictedEnergyConsume * adjustmentFactor;

        // Hitung emisi yang diprediksi
        const predictedEmission =
          predictedEnergyConsumeActual * EMISSION_FACTOR;

        return {
          time,
          R_AVG,
          S_AVG,
          T_AVG,
          IA1_AVG,
          IA2_AVG,
          IA3_AVG,
          PF_AVG,
          energyConsumeR: totalEnergyConsumeR,
          energyConsumeS: totalEnergyConsumeS,
          energyConsumeT: totalEnergyConsumeT,
          energyConsume: totalEnergyConsume,
          energyConsumeActual,
          energyConsume_AVG:
            daysElapsed > 0 ? totalEnergyConsume / daysElapsed : 0,
          predictedEnergyConsume,
          predictedEnergyConsumeActual,
          emission,
          emission_AVG: daysElapsed > 0 ? emission / daysElapsed : 0,
          predictedEmission,
        };
      });
    };

    const monthlyGroupedLogs = groupLogsByGranularity(logs, 7); // YYYY-MM
    const monthlyData = calculateAggregatedMetrics(monthlyGroupedLogs);

    res.json({
      success: true,
      data: {
        monthlyData,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: `Terjadi kesalahan saat mengolah data: ${err.message}`,
    });
  }
});

// ENDPOINT NERIMA DATA DARI ALAT
app.post("/addData/:floor", async (req, res) => {
  // Mulai logging
  try {
    const { floor } = req.params;
    // Validate floor parameter
    if (!floorTableMap[floor]) {
      return res.status(400).json({
        success: false,
        message: "Invalid floor parameter",
      });
    }

    const tableName = floorTableMap[floor];
    const {
      no_kWh_Meter,
      v_avg,
      I_avg,
      PF_avg,
      kVA,
      kW,
      kVArh,
      freq,
      v_L1,
      v_L2,
      v_L3,
      v_12,
      v_23,
      v_31,
      I_A1,
      I_A2,
      I_A3,
    } = req.body;

    // Validasi field yang diperlukan
    if (
      !no_kWh_Meter ||
      !v_avg ||
      !I_avg ||
      !PF_avg ||
      !kVA ||
      !kW ||
      !kVArh ||
      !freq ||
      !v_L1 ||
      !v_L2 ||
      !v_L3 ||
      !v_12 ||
      !v_23 ||
      !v_31 ||
      !I_A1 ||
      !I_A2 ||
      !I_A3
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields in request body",
      });
    }

    // Query untuk mendapatkan nama meter
    const meterQuery = await connectionPool
      .request()
      .input("no_kWh_Meter", sql.NVarChar, no_kWh_Meter)
      .query(
        `SELECT nama_kWh_Meter FROM ${tableName} WHERE no_kWh_Meter = @no_kWh_Meter`
      );

    if (meterQuery.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: `no_kWh_Meter ${no_kWh_Meter} not found in ${tableName}`,
      });
    }

    const nama_kWh_Meter = meterQuery.recordset[0].nama_kWh_Meter;
    // Sanitize nama_kWh_Meter untuk nama tabel
    const sanitizedTableName = `tbl_log_${nama_kWh_Meter.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    // Periksa apakah tabel log ada
    const tableCheck = await connectionPool
      .request()
      .query(
        `SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = '${sanitizedTableName}'`
      );

    if (tableCheck.recordset.length === 0) {
      return res.status(400).json({
        success: false,
        message: `Log table ${sanitizedTableName} does not exist`,
      });
    }

    const logWaktuWIB =
      req.body.log_waktu ||
      moment().tz("Asia/Jakarta").format("YYYY-MM-DD HH:mm:ss");

    await connectionPool
      .request()
      .input("no_kWh_Meter", sql.NVarChar, no_kWh_Meter)
      .input("nama_kWh_Meter", sql.NVarChar, nama_kWh_Meter)
      .input("freq", sql.NVarChar, freq)
      .input("v_avg", sql.NVarChar, v_avg)
      .input("I_avg", sql.NVarChar, I_avg)
      .input("PF_avg", sql.NVarChar, PF_avg)
      .input("kVA", sql.NVarChar, kVA)
      .input("kW", sql.NVarChar, kW)
      .input("kVArh", sql.NVarChar, kVArh)
      .input("v_L1", sql.NVarChar, v_L1)
      .input("v_L2", sql.NVarChar, v_L2)
      .input("v_L3", sql.NVarChar, v_L3)
      .input("v_12", sql.NVarChar, v_12)
      .input("v_23", sql.NVarChar, v_23)
      .input("v_31", sql.NVarChar, v_31)
      .input("I_A1", sql.NVarChar, I_A1)
      .input("I_A2", sql.NVarChar, I_A2)
      .input("I_A3", sql.NVarChar, I_A3)
      .input("log_waktu", sql.NVarChar, logWaktuWIB)
      .query(`
        INSERT INTO ${sanitizedTableName} (
            no_kWh_Meter, nama_kWh_Meter, freq, v_avg, I_avg, PF_avg, 
            kVA, kW, kVArh, v_L1, v_L2, v_L3, 
            v_12, v_23, v_31, I_A1, I_A2, I_A3, log_waktu
        ) VALUES (
            @no_kWh_Meter, @nama_kWh_Meter, @freq, @v_avg, @I_avg, @PF_avg, 
            @kVA, @kW, @kVArh, @v_L1, @v_L2, @v_L3, 
            @v_12, @v_23, @v_31, @I_A1, @I_A2, @I_A3, @log_waktu
        )`);
    res.json({
      success: true,
      message: `Data successfully inserted into log table ${sanitizedTableName}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: `Error inserting data: ${err.message}`,
    });
  } finally {
  }
});

//--ENDPOINT ROOT
app.get("/", (req, res) => {
  res.status(200).send("<h1>Server is running</h1>");
});


// Endpoint untuk monitoring penggunaan CPU dan RAM MSSQL
app.get("/m", async (req, res) => {
  try {
    // Query untuk Memory in Use (MB)
    const queryMemory = `
      SELECT 
        TRY_CONVERT(INT, physical_memory_in_use_kb / 1024) AS memory_in_use_mb
      FROM sys.dm_os_process_memory;
    `;

    // Jalankan query
    const pool = await connectionPool; // Pastikan koneksi pool sudah siap
    const memoryResult = await pool.request().query(queryMemory);

    // Validasi hasil query
    const memoryData = (memoryResult.recordset && memoryResult.recordset[0]) || {};

    // Format hasil untuk response
    const response = {
      memory: {
        in_use_MB: memoryData.memory_in_use_mb || 0,
      },
    };

    res.status(200).json(response);
  } catch (err) {
    console.error("Error fetching MSSQL memory stats:", err);
    res.status(500).json({
      error: "Failed to fetch MSSQL memory stats",
      details: err.message,
    });
  }
});


// initializeConnectionPool().then(() => {
//   // Kemudian set interval untuk menjalankan kedua fungsi setiap 50 detik setelah delay awal
//   setInterval(runFloorCalculations, 600000); 
//   setInterval(calculateDashboard, 600000);   
// });

// Endpoint untuk menjalankan kedua fungsi
app.get('/run', async (req, res) => {
  // Kirim respons segera
  res.status(200).json({ success: true, message: 'Sedang di hitung' });

  // Jalankan kedua fungsi secara asinkron
  try {
    await runFloorCalculations();
    console.log('Floor calculations completed.');
  } catch (error) {
    console.error('Error during floor calculations:', error);
  }

  try {
    await calculateDashboard();
    console.log('Dashboard calculations completed.');
  } catch (error) {
    console.error('Error during dashboard calculations:', error);
  }
});

initializeConnectionPool().then(async () => {
  // Jalankan kalkulasi saat server pertama kali berjalan
  await runFloorCalculations();
  await calculateDashboard();
  
  // // Kemudian set interval untuk menjalankan kedua fungsi setiap 10 menit
  // setInterval(async () => {
  //   await runFloorCalculations();
  // }, 60000); // 1 menit

  // setInterval(async () => {
  //   await calculateDashboard();
  // }, 60000); // 1 menit
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port http://localhost:${PORT}`);
});

