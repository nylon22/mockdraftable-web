// @flow

// import { groupBy, mapValues } from 'lodash';

import db from './connection';
import { getById, getByKey, getDefaultPosition } from './positions';
import { getByKey as getMeasurableByKey } from './measurables';
import { Sorts, defaultSort, PlayerStatuses } from './types/domain';
import type {
  Player,
  PlayerKey,
  PositionId,
  PositionKey,
  PlayerPositions,
  MeasurableKey,
  Measurement,
  PlayerStore,
  MeasurementStore,
  StatisticsStore,
  PositionEligibilityStore,
} from './types/domain';

const playerStore: PlayerStore = new Map();
const measurementStore: MeasurementStore = new Map();
const statisticsStore: StatisticsStore = new Map();
const positionEligibilityStore: PositionEligibilityStore = new Map();

const stores = {
  playerStore,
  measurementStore,
  statisticsStore,
  positionEligibilityStore,
};

const getPlayers = async (): Promise<Array<Player>> =>
  (await db.many(
    `select
        p.canonical_name as id,
        CONCAT(p.first_name, ' ', p.last_name) as name,
        p.draft_year as draft,
        p.id as key,
        s.name as school,
        p.status as status
      from t_player as p
      left join t_school as s
        on p.school_id = s.id;`,
  )).map((p) => {
    let status = PlayerStatuses.OKAY;
    if (p.status === 1) {
      status = PlayerStatuses.PENDING;
    } else if (p.status === 2) {
      status = PlayerStatuses.NOVELTY;
    }
    return Object.assign({}, p, { status });
  });

/*
const getAllPlayerPositions = async () =>
  mapValues(
    groupBy(
      await db.many(
        'select player_id as player_key, position_id as position_key from t_position_eligibility'
      ),
      row => row.player_key,
    ),
    values => impliedPositions(values.map(value => value.position_key)),
  );

const getAllPlayerMeasurements = async () =>
  mapValues(
    groupBy(
      await db.many(
        `select
          player_id as player_key,
          measurable_id as measurable_key,
          measurement,
          source
        from t_measurement`
      ),
      row => row.player_key,
    ),
    values =>
      Object.values(
        values.reduce(
        )
      ).map(
        (value: any) => ({
          measurableKey: value.measurable_key,
          measurement: value.measurement,
          source: value.source,
        }),
      ),
  );
*/

const getPositionsForPlayer: PlayerKey => Promise<Array<PositionKey>> = async key =>
  (await db.manyOrNone(
    `select
        position_id as position_key
      from t_position_eligibility
      where player_id = $(key)`,
    { key },
  )).map(result => result.position_key);

type DBMeasurement = {
  measurable: MeasurableKey,
  measurement: number,
  source: number,
};

const getBestMeasurementsForPlayer = async (key: PlayerKey) =>
  Object.values(
    (await db.manyOrNone(
      `select 
          measurable_id as measurable,
          measurement,
          source
        from t_measurement
        where player_id=$(key)`,
      { key },
    )).reduce(
      (accum: { [MeasurableKey]: DBMeasurement }, value: DBMeasurement) => {
        const meas: MeasurableKey = value.measurable;
        if (!accum[meas]
          || (accum[meas].measurement > value.measurement
            && defaultSort(getMeasurableByKey(meas).unit) === Sorts.ASC)
          || (accum[meas].measurement < value.measurement
            && defaultSort(getMeasurableByKey(meas).unit) === Sorts.DESC)) {
          const retval = Object.assign({}, accum);
          retval[meas] = value;
          return retval;
        }
        return accum;
      },
      {},
    ),
  ).map((measurement: any) => {
    const retval = Object.assign({}, measurement, { measurableKey: measurement.measurable });
    delete retval.measurable;
    return retval;
  }).sort((a: Measurement, b: Measurement) => {
    if (a.measurableKey === 9) {
      return 1;
    } else if (b.measurableKey === 9) {
      return -1;
    }
    return a.measurableKey - b.measurableKey;
  });

const impliedPositions = (explicitPositionIds: Array<PositionKey>): PlayerPositions => {
  const impliedSet = ['ATH'];
  explicitPositionIds.forEach((positionKey) => {
    const stringPosId = positionKey.toString(10);
    for (let offset = 0; stringPosId.length - offset > 0; offset += 1) {
      const posId = stringPosId.substr(0, stringPosId.length - offset);
      if (posId !== '80') {
        // Special teams has a special case.
        const pos = getByKey(parseInt(posId, 10));
        if (pos && impliedSet.indexOf(pos.id) === -1) {
          impliedSet.push(pos.id);
        }
      }
    }
  });
  if (impliedSet.indexOf('DE') !== -1 || impliedSet.indexOf('34B') !== -1) {
    impliedSet.push('EDGE');
  }
  return {
    primary: getDefaultPosition(impliedSet.map(pid => getById(pid))).id,
    all: impliedSet,
  };
};

export default async () => {
  console.time('Player Load');

  await Promise.all((await getPlayers()).map(async (player: Player) => {
    playerStore.set(player.id, Object.assign({}, player, {
      positions: impliedPositions(await getPositionsForPlayer(player.key)),
      measurements: await getBestMeasurementsForPlayer(player.key),
    }));
  }));

  console.timeEnd('Player Load');
  console.time('Stats Compute');

  const positionCounters: Map<PositionId, number> = new Map();
  const measurementCounters: Map<PositionId, Map<MeasurableKey, number>> = new Map();
  const measurementSums: Map<PositionId, Map<MeasurableKey, number>> = new Map();
  const measurementMeans: Map<PositionId, Map<MeasurableKey, number>> = new Map();
  const measurementDeviationSums: Map<PositionId, Map<MeasurableKey, number>> = new Map();
  const measurementIndicies: Map<PositionId, Map<MeasurableKey, number>> = new Map();

  playerStore.forEach((player) => {
    if (player.status !== PlayerStatuses.OKAY) {
      return;
    }
    player.positions.all.forEach((positionId) => {
      positionCounters.set(positionId, (positionCounters.get(positionId) || 0) + 1);
      player.measurements.forEach(({ measurableKey, measurement }) => {
        if (!measurementDeviationSums.has(positionId)) {
          measurementDeviationSums.set(positionId, new Map());
        }
        if (!measurementIndicies.has(positionId)) {
          measurementIndicies.set(positionId, new Map());
        }
        const posCounters = measurementCounters.get(positionId) || new Map();
        posCounters.set(measurableKey, (posCounters.get(measurableKey) || 0) + 1);
        measurementCounters.set(positionId, posCounters);
        const posSums = measurementSums.get(positionId) || new Map();
        posSums.set(measurableKey, (posSums.get(measurableKey) || 0) + measurement);
        measurementSums.set(positionId, posSums);
      });
    });
  });

  measurementCounters.forEach((map: Map<MeasurableKey, number>, positionId: PositionId) => {
    map.forEach((count: number, measurableKey: MeasurableKey) => {
      const measurableMap = measurementStore.get(positionId) || new Map();
      measurementStore.set(positionId, measurableMap);
      measurableMap.set(measurableKey, new Float32Array(count));
      const meansMap = measurementMeans.get(positionId) || new Map();
      meansMap.set(
        measurableKey,
        // $FlowFixMe
        measurementSums.get(positionId).get(measurableKey) /
          // $FlowFixMe
          (measurementCounters.get(positionId).get(measurableKey) || 1),
      );
      measurementMeans.set(positionId, meansMap);
    });
  });

  playerStore.forEach((player) => {
    if (player.status !== PlayerStatuses.OKAY) {
      return;
    }
    player.positions.all.forEach((positionId) => {
      const positionList = positionEligibilityStore.get(positionId) || [];
      positionList.push(player.id);
      positionEligibilityStore.set(positionId, positionList);
      player.measurements.forEach(({ measurableKey, measurement }) => {
        // $FlowFixMe
        const deviation = (measurement - measurementMeans.get(positionId).get(measurableKey)) ** 2;
        // $FlowFixMe
        measurementDeviationSums.get(positionId).set(
          measurableKey,
          // $FlowFixMe
          (measurementDeviationSums.get(positionId).get(measurableKey) || 0) + deviation,
        );
        // $FlowFixMe
        const measurementIndex = measurementIndicies.get(positionId).get(measurableKey) || 0;
        // $FlowFixMe
        measurementIndicies.get(positionId).set(measurableKey, measurementIndex + 1);
        // $FlowFixMe
        measurementStore.get(positionId).get(measurableKey)[measurementIndex] = measurement;
      });
    });
  });

  measurementStore.forEach(map => map.forEach(measurements => measurements.sort((a, b) => a - b)));

  measurementDeviationSums.forEach((map, positionId) => {
    const positionStatisticsStore = statisticsStore.get(positionId) || new Map();
    map.forEach((deviationSum, measurableKey) => {
      // $FlowFixMe
      const count = measurementCounters.get(positionId).get(measurableKey) || 1;
      positionStatisticsStore.set(measurableKey, {
        count,
        // $FlowFixMe
        mean: measurementMeans.get(positionId).get(measurableKey) || 0,
        stddev: Math.sqrt(deviationSum / count),
      });
    });
    statisticsStore.set(positionId, positionStatisticsStore);
  });

  console.timeEnd('Stats Compute');
  return stores;
};
