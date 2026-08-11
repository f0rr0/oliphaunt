#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <inttypes.h>
#include <libpq-fe.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define MAX_CLIENTS 64
#define MAX_DURATION_SECONDS 86400
#define MAX_TPS_PER_CLIENT 10000
#define FLUSH_INTERVAL 256

struct options
{
	const char *conninfo;
	const char *output_path;
	const char *flush_output_path;
	uint64_t clients;
	uint64_t duration_seconds;
	uint64_t tps_per_client;
	uint64_t stagger_us;
	uint64_t sequence_offset;
};

struct shared_state
{
	const struct options *options;
	FILE *output;
	FILE *flush_output;
	pthread_mutex_t mutex;
	pthread_cond_t condition;
	uint64_t ready_count;
	bool released;
	bool failed;
	uint64_t start_monotonic_ns;
};

struct client_state
{
	struct shared_state *shared;
	uint64_t client_id;
};

static void
usage(FILE *stream, const char *program)
{
	fprintf(stream,
			"usage: %s --conninfo CONNINFO --clients N --duration-seconds N "
			"--tps-per-client N --stagger-us N --sequence-offset N "
			"--output PATH --flush-output PATH\n",
			program);
}

static bool
parse_u64(const char *text, bool allow_zero, uint64_t *value)
{
	char *end = NULL;
	unsigned long long parsed;

	if (text == NULL || text[0] == '\0' || text[0] == '-')
		return false;
	errno = 0;
	parsed = strtoull(text, &end, 10);
	if (errno != 0 || end == text || *end != '\0' || (!allow_zero && parsed == 0))
		return false;
	*value = (uint64_t) parsed;
	return true;
}

static bool
parse_options(int argc, char **argv, struct options *options)
{
	int i;
	bool have_clients = false;
	bool have_duration = false;
	bool have_tps = false;
	bool have_stagger = false;
	bool have_offset = false;

	memset(options, 0, sizeof(*options));
	for (i = 1; i < argc; i++)
	{
		const char *name = argv[i];
		const char *value;

		if (strcmp(name, "--help") == 0 || strcmp(name, "-h") == 0)
		{
			usage(stdout, argv[0]);
			exit(0);
		}
		if (i + 1 >= argc)
			return false;
		value = argv[++i];
		if (strcmp(name, "--conninfo") == 0 && options->conninfo == NULL)
			options->conninfo = value;
		else if (strcmp(name, "--output") == 0 && options->output_path == NULL)
			options->output_path = value;
		else if (strcmp(name, "--flush-output") == 0 && options->flush_output_path == NULL)
			options->flush_output_path = value;
		else if (strcmp(name, "--clients") == 0 && !have_clients)
		{
			have_clients = parse_u64(value, false, &options->clients);
			if (!have_clients)
				return false;
		}
		else if (strcmp(name, "--duration-seconds") == 0 && !have_duration)
		{
			have_duration = parse_u64(value, false, &options->duration_seconds);
			if (!have_duration)
				return false;
		}
		else if (strcmp(name, "--tps-per-client") == 0 && !have_tps)
		{
			have_tps = parse_u64(value, false, &options->tps_per_client);
			if (!have_tps)
				return false;
		}
		else if (strcmp(name, "--stagger-us") == 0 && !have_stagger)
		{
			have_stagger = parse_u64(value, true, &options->stagger_us);
			if (!have_stagger)
				return false;
		}
		else if (strcmp(name, "--sequence-offset") == 0 && !have_offset)
		{
			have_offset = parse_u64(value, true, &options->sequence_offset);
			if (!have_offset)
				return false;
		}
		else
			return false;
	}

	return options->conninfo != NULL && options->output_path != NULL &&
		options->flush_output_path != NULL && have_clients && have_duration &&
		have_tps && have_stagger && have_offset && options->clients <= MAX_CLIENTS &&
		options->duration_seconds <= MAX_DURATION_SECONDS &&
		options->tps_per_client <= MAX_TPS_PER_CLIENT &&
		options->stagger_us <= UINT64_C(1000000);
}

static bool
clock_ns(clockid_t clock_id, uint64_t *value)
{
	struct timespec now;

	if (clock_gettime(clock_id, &now) != 0 || now.tv_sec < 0)
		return false;
	if ((uint64_t) now.tv_sec > UINT64_MAX / UINT64_C(1000000000))
		return false;
	*value = (uint64_t) now.tv_sec * UINT64_C(1000000000) +
		(uint64_t) now.tv_nsec;
	return true;
}

static bool
sleep_until(uint64_t deadline_ns)
{
	struct timespec deadline;
	int status;

	deadline.tv_sec = (time_t) (deadline_ns / UINT64_C(1000000000));
	deadline.tv_nsec = (long) (deadline_ns % UINT64_C(1000000000));
	do
	{
		status = clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &deadline, NULL);
	} while (status == EINTR);
	return status == 0;
}

static void
mark_failed(struct shared_state *shared)
{
	pthread_mutex_lock(&shared->mutex);
	shared->failed = true;
	pthread_cond_broadcast(&shared->condition);
	pthread_mutex_unlock(&shared->mutex);
}

static bool
write_transaction(struct shared_state *shared, uint64_t client_id,
				  uint64_t sequence, uint64_t scheduled_ns,
				  uint64_t start_mono_ns, uint64_t end_mono_ns,
				  uint64_t start_real_ns, uint64_t end_real_ns,
				  const char *status, const char *updates,
				  const char *inserts, const char *reads, const char *insert_lsn)
{
	uint64_t service_ns = end_mono_ns >= start_mono_ns ?
		end_mono_ns - start_mono_ns : 0;
	uint64_t lateness_ns = start_mono_ns > scheduled_ns ?
		start_mono_ns - scheduled_ns : 0;
	int written;

	pthread_mutex_lock(&shared->mutex);
	written = fprintf(shared->output,
				  "1\t%" PRIu64 "\t%" PRIu64 "\t%" PRIu64 "\t%" PRIu64
				  "\t%" PRIu64 "\t%" PRIu64 "\t%" PRIu64 "\t%" PRIu64
				  "\t%" PRIu64 "\t%s\t%s\t%s\t%s\t%s\n",
				  client_id, sequence, scheduled_ns, start_mono_ns, end_mono_ns,
				  start_real_ns, end_real_ns, service_ns, lateness_ns, status,
				  updates, inserts, reads, insert_lsn);
	if (sequence % FLUSH_INTERVAL == 0)
		(void) fflush(shared->output);
	pthread_mutex_unlock(&shared->mutex);
	return written >= 0;
}

static bool
write_flush(struct shared_state *shared, uint64_t client_id,
			uint64_t through_sequence, const char *insert_lsn,
			const char *flush_lsn, const char *covers, const char *status)
{
	int written;

	pthread_mutex_lock(&shared->mutex);
	written = fprintf(shared->flush_output,
				  "1\t%" PRIu64 "\t%" PRIu64 "\t%s\t%s\t%s\t%s\n",
				  client_id, through_sequence, insert_lsn, flush_lsn, covers, status);
	(void) fflush(shared->flush_output);
	pthread_mutex_unlock(&shared->mutex);
	return written >= 0;
}

static bool
flush_covers(PGconn *connection, struct shared_state *shared, uint64_t client_id,
			 uint64_t sequence, const char *insert_lsn)
{
	const char *values[1] = {insert_lsn};
	PGresult *result = PQexecParams(connection,
		"SELECT pg_current_wal_flush_lsn()::text, "
		"pg_current_wal_flush_lsn() >= $1::pg_lsn",
		1, NULL, values, NULL, NULL, 0);
	const char *flush_lsn = "";
	const char *covers = "f";
	const char *status = "query_error";
	bool ok = false;

	if (result != NULL && PQresultStatus(result) == PGRES_TUPLES_OK &&
		PQntuples(result) == 1 && PQnfields(result) == 2 &&
		!PQgetisnull(result, 0, 0) && !PQgetisnull(result, 0, 1))
	{
		flush_lsn = PQgetvalue(result, 0, 0);
		covers = PQgetvalue(result, 0, 1);
		status = strcmp(covers, "t") == 0 ? "ok" : "not_covered";
		ok = strcmp(status, "ok") == 0;
	}
	if (!write_flush(shared, client_id, sequence, insert_lsn,
					 flush_lsn, covers, status))
		ok = false;
	if (result != NULL)
		PQclear(result);
	return ok;
}

static void *
run_client(void *opaque)
{
	struct client_state *client = opaque;
	struct shared_state *shared = client->shared;
	const struct options *options = shared->options;
	PGconn *connection = PQconnectdb(options->conninfo);
	PGresult *prepared = NULL;
	bool connection_ready = false;
	uint64_t transactions = options->duration_seconds * options->tps_per_client;
	uint64_t interval_ns = UINT64_C(1000000000) / options->tps_per_client;
	uint64_t index;
	uint64_t last_successful_sequence = 0;
	char last_insert_lsn[64] = "";

	if (connection != NULL && PQstatus(connection) == CONNECTION_OK)
	{
		prepared = PQprepare(connection, "oliphaunt_checkpoint_tx",
			"SELECT update_count, insert_count, read_count, insert_lsn::text "
			"FROM oliphaunt_checkpoint_transaction($1::integer, $2::bigint)",
			2, NULL);
		connection_ready = prepared != NULL &&
			PQresultStatus(prepared) == PGRES_COMMAND_OK;
	}
	if (prepared != NULL)
		PQclear(prepared);

	pthread_mutex_lock(&shared->mutex);
	shared->ready_count++;
	if (!connection_ready)
		shared->failed = true;
	pthread_cond_broadcast(&shared->condition);
	while (!shared->released)
		pthread_cond_wait(&shared->condition, &shared->mutex);
	pthread_mutex_unlock(&shared->mutex);

	if (!connection_ready)
	{
		if (connection != NULL)
			PQfinish(connection);
		return NULL;
	}

	for (index = 1; index <= transactions; index++)
	{
		uint64_t sequence = options->sequence_offset + index;
		uint64_t scheduled_ns = shared->start_monotonic_ns +
			(client->client_id - 1) * options->stagger_us * UINT64_C(1000) +
			(index - 1) * interval_ns;
		uint64_t start_mono_ns = 0;
		uint64_t end_mono_ns = 0;
		uint64_t start_real_ns = 0;
		uint64_t end_real_ns = 0;
		char client_text[32];
		char sequence_text[32];
		const char *values[2];
		PGresult *result = NULL;
		const char *status = "query_error";
		const char *updates = "";
		const char *inserts = "";
		const char *reads = "";
		const char *insert_lsn = "";

		if (!sleep_until(scheduled_ns) || !clock_ns(CLOCK_MONOTONIC, &start_mono_ns) ||
			!clock_ns(CLOCK_REALTIME, &start_real_ns))
		{
			mark_failed(shared);
			break;
		}
		if (start_mono_ns > scheduled_ns + interval_ns)
		{
			(void) clock_ns(CLOCK_REALTIME, &end_real_ns);
			end_mono_ns = start_mono_ns;
			if (!write_transaction(shared, client->client_id, sequence,
					scheduled_ns, start_mono_ns, end_mono_ns,
					start_real_ns, end_real_ns, "skipped", "", "", "", ""))
				mark_failed(shared);
			continue;
		}

		(void) snprintf(client_text, sizeof(client_text), "%" PRIu64, client->client_id);
		(void) snprintf(sequence_text, sizeof(sequence_text), "%" PRIu64, sequence);
		values[0] = client_text;
		values[1] = sequence_text;
		result = PQexecPrepared(connection, "oliphaunt_checkpoint_tx", 2,
			values, NULL, NULL, 0);
		if (!clock_ns(CLOCK_MONOTONIC, &end_mono_ns) ||
			!clock_ns(CLOCK_REALTIME, &end_real_ns))
			status = "clock_error";
		else if (result != NULL && PQresultStatus(result) == PGRES_TUPLES_OK &&
			PQntuples(result) == 1 && PQnfields(result) == 4 &&
			!PQgetisnull(result, 0, 0) && !PQgetisnull(result, 0, 1) &&
			!PQgetisnull(result, 0, 2) && !PQgetisnull(result, 0, 3))
		{
			updates = PQgetvalue(result, 0, 0);
			inserts = PQgetvalue(result, 0, 1);
			reads = PQgetvalue(result, 0, 2);
			insert_lsn = PQgetvalue(result, 0, 3);
			status = strcmp(updates, "48") == 0 && strcmp(inserts, "16") == 0 &&
				strcmp(reads, "8") == 0 && strchr(insert_lsn, '/') != NULL ?
				"ok" : "result_error";
		}
		if (!write_transaction(shared, client->client_id, sequence, scheduled_ns,
				start_mono_ns, end_mono_ns, start_real_ns, end_real_ns,
				status, updates, inserts, reads, insert_lsn))
			status = "write_error";
		if (strcmp(status, "ok") == 0)
		{
			last_successful_sequence = sequence;
			(void) snprintf(last_insert_lsn, sizeof(last_insert_lsn), "%s", insert_lsn);
			if (index % FLUSH_INTERVAL == 0 &&
				!flush_covers(connection, shared, client->client_id,
					last_successful_sequence, last_insert_lsn))
				status = "flush_error";
		}
		if (result != NULL)
			PQclear(result);
		if (strcmp(status, "ok") != 0)
		{
			mark_failed(shared);
			break;
		}
	}

	if (last_successful_sequence != 0 &&
		(last_successful_sequence - options->sequence_offset) % FLUSH_INTERVAL != 0 &&
		!flush_covers(connection, shared, client->client_id,
			last_successful_sequence, last_insert_lsn))
		mark_failed(shared);
	PQfinish(connection);
	return NULL;
}

int
main(int argc, char **argv)
{
	struct options options;
	struct shared_state shared;
	pthread_t threads[MAX_CLIENTS];
	struct client_state clients[MAX_CLIENTS];
	uint64_t index;
	uint64_t now_ns;
	int status = 0;

	if (!parse_options(argc, argv, &options))
	{
		usage(stderr, argv[0]);
		return 2;
	}
	memset(&shared, 0, sizeof(shared));
	shared.options = &options;
	shared.output = fopen(options.output_path, "wx");
	shared.flush_output = fopen(options.flush_output_path, "wx");
	if (shared.output == NULL || shared.flush_output == NULL)
	{
		fprintf(stderr, "checkpoint probe could not create exclusive evidence outputs\n");
		if (shared.output != NULL)
			(void) fclose(shared.output);
		if (shared.flush_output != NULL)
			(void) fclose(shared.flush_output);
		return 73;
	}
	if (fprintf(shared.output,
			"schema_version\tclient\tsequence\tscheduled_mono_ns\tstart_mono_ns\tend_mono_ns\tstart_real_ns\tend_real_ns\tservice_ns\tlateness_ns\tstatus\tupdate_count\tinsert_count\tread_count\tinsert_lsn\n") < 0 ||
		fprintf(shared.flush_output,
			"schema_version\tclient\tthrough_sequence\tinsert_lsn\tflush_lsn\tcovers\tstatus\n") < 0 ||
		pthread_mutex_init(&shared.mutex, NULL) != 0 ||
		pthread_cond_init(&shared.condition, NULL) != 0)
	{
		fprintf(stderr, "checkpoint probe could not initialize evidence\n");
		(void) fclose(shared.output);
		(void) fclose(shared.flush_output);
		return 74;
	}

	for (index = 0; index < options.clients; index++)
	{
		clients[index].shared = &shared;
		clients[index].client_id = index + 1;
		if (pthread_create(&threads[index], NULL, run_client, &clients[index]) != 0)
		{
			mark_failed(&shared);
			status = 1;
			break;
		}
	}
	if (status == 0)
	{
		pthread_mutex_lock(&shared.mutex);
		while (shared.ready_count < options.clients)
			pthread_cond_wait(&shared.condition, &shared.mutex);
		if (!clock_ns(CLOCK_MONOTONIC, &now_ns))
			shared.failed = true;
		else
			shared.start_monotonic_ns = now_ns + UINT64_C(1000000000);
		shared.released = true;
		pthread_cond_broadcast(&shared.condition);
		pthread_mutex_unlock(&shared.mutex);
	}
	else
	{
		pthread_mutex_lock(&shared.mutex);
		shared.released = true;
		pthread_cond_broadcast(&shared.condition);
		pthread_mutex_unlock(&shared.mutex);
	}

	for (uint64_t joined = 0; joined < index; joined++)
		if (pthread_join(threads[joined], NULL) != 0)
			status = 1;
	if (fflush(shared.output) != 0 || fflush(shared.flush_output) != 0 ||
		fclose(shared.output) != 0 || fclose(shared.flush_output) != 0)
		status = 1;
	if (shared.failed)
		status = 1;
	(void) pthread_cond_destroy(&shared.condition);
	(void) pthread_mutex_destroy(&shared.mutex);
	return status;
}
