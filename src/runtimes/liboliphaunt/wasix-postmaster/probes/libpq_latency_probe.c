#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <inttypes.h>
#include <libpq-fe.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define MAX_SAMPLE_COUNT UINT64_C(10000000)

enum probe_mode
{
	PROBE_MODE_PERSISTENT,
	PROBE_MODE_RECONNECT
};

struct options
{
	const char *conninfo;
	const char *mode_name;
	const char *output_path;
	enum probe_mode mode;
	uint64_t warmup_count;
	uint64_t sample_count;
};

static void
usage(FILE *stream, const char *program)
{
	fprintf(stream,
			"usage: %s --conninfo CONNINFO --mode persistent|reconnect "
			"--warmup COUNT --samples COUNT --output PATH\n",
			program);
}

static bool
parse_count(const char *text, bool allow_zero, uint64_t *value)
{
	char *end = NULL;
	unsigned long long parsed;

	if (text == NULL || text[0] == '\0' || text[0] == '-')
		return false;
	errno = 0;
	parsed = strtoull(text, &end, 10);
	if (errno != 0 || end == text || *end != '\0' ||
		(!allow_zero && parsed == 0))
		return false;
	*value = (uint64_t) parsed;
	return true;
}

static bool
parse_options(int argc, char **argv, struct options *options)
{
	int i;
	bool have_warmup = false;
	bool have_samples = false;

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
		else if (strcmp(name, "--mode") == 0 && options->mode_name == NULL)
		{
			options->mode_name = value;
			if (strcmp(value, "persistent") == 0)
				options->mode = PROBE_MODE_PERSISTENT;
			else if (strcmp(value, "reconnect") == 0)
				options->mode = PROBE_MODE_RECONNECT;
			else
				return false;
		}
		else if (strcmp(name, "--warmup") == 0 && !have_warmup)
		{
			if (!parse_count(value, true, &options->warmup_count))
				return false;
			have_warmup = true;
		}
		else if (strcmp(name, "--samples") == 0 && !have_samples)
		{
			if (!parse_count(value, false, &options->sample_count))
				return false;
			have_samples = true;
		}
		else
			return false;
	}

	return options->conninfo != NULL && options->mode_name != NULL &&
		options->output_path != NULL && have_warmup && have_samples &&
		options->warmup_count <= MAX_SAMPLE_COUNT &&
		options->sample_count <= MAX_SAMPLE_COUNT;
}

static bool
monotonic_now(struct timespec *timestamp)
{
	return clock_gettime(CLOCK_MONOTONIC, timestamp) == 0;
}

static bool
elapsed_nanoseconds(const struct timespec *start, const struct timespec *end,
					uint64_t *duration_ns)
{
	time_t seconds;
	long nanoseconds;
	uint64_t duration;

	seconds = end->tv_sec - start->tv_sec;
	nanoseconds = end->tv_nsec - start->tv_nsec;
	if (nanoseconds < 0)
	{
		seconds--;
		nanoseconds += 1000000000L;
	}
	if (seconds < 0 || (uint64_t) seconds > UINT64_MAX / UINT64_C(1000000000))
		return false;
	duration = (uint64_t) seconds * UINT64_C(1000000000) +
		(uint64_t) nanoseconds;
	if (duration == 0)
		return false;
	*duration_ns = duration;
	return true;
}

static bool
result_is_select_one(const PGresult *result)
{
	return result != NULL && PQresultStatus(result) == PGRES_TUPLES_OK &&
		PQntuples(result) == 1 && PQnfields(result) == 1 &&
		!PQgetisnull(result, 0, 0) &&
		strcmp(PQgetvalue(result, 0, 0), "1") == 0;
}

static const char *
run_persistent_query(PGconn *connection, uint64_t *duration_ns)
{
	struct timespec started;
	struct timespec finished;
	PGresult *result;
	const char *status = "ok";

	if (!monotonic_now(&started))
		return "clock_error";
	result = PQexec(connection, "SELECT 1");
	if (!monotonic_now(&finished))
		status = "clock_error";
	else if (result == NULL)
		status = "query_error";
	else if (!result_is_select_one(result))
		status = "result_error";
	else if (!elapsed_nanoseconds(&started, &finished, duration_ns))
		status = "clock_error";
	if (result != NULL)
		PQclear(result);
	return status;
}

static const char *
run_reconnect_query(const char *conninfo, uint64_t *duration_ns)
{
	struct timespec started;
	struct timespec finished;
	PGconn *connection = NULL;
	PGresult *result = NULL;
	const char *status = "ok";

	if (!monotonic_now(&started))
		return "clock_error";
	connection = PQconnectdb(conninfo);
	if (connection == NULL || PQstatus(connection) != CONNECTION_OK)
		status = "connect_error";
	else
	{
		result = PQexec(connection, "SELECT 1");
		if (result == NULL)
			status = "query_error";
		else if (!result_is_select_one(result))
			status = "result_error";
	}
	if (result != NULL)
		PQclear(result);
	if (connection != NULL)
		PQfinish(connection);
	if (!monotonic_now(&finished) ||
		!elapsed_nanoseconds(&started, &finished, duration_ns))
		status = "clock_error";
	return status;
}

static bool
write_row(FILE *output, const struct options *options, const char *phase,
		  uint64_t index, uint64_t duration_ns, const char *status)
{
	if (fprintf(output, "1\t%s\t%s\t%" PRIu64 "\t%" PRIu64 "\t%s\n",
				options->mode_name, phase, index, duration_ns, status) < 0)
		return false;
	return fflush(output) == 0;
}

static bool
write_connection_failure(FILE *output, const struct options *options)
{
	const char *phase = options->warmup_count > 0 ? "warmup" : "measure";

	return write_row(output, options, phase, 1, 0, "connect_error");
}

static int
run_phase(FILE *output, const struct options *options, PGconn *connection,
		  const char *phase, uint64_t count)
{
	uint64_t index;

	for (index = 1; index <= count; index++)
	{
		uint64_t duration_ns = 0;
		const char *status;

		if (options->mode == PROBE_MODE_PERSISTENT)
			status = run_persistent_query(connection, &duration_ns);
		else
			status = run_reconnect_query(options->conninfo, &duration_ns);
		if (!write_row(output, options, phase, index, duration_ns, status))
		{
			fprintf(stderr, "libpq latency probe could not write raw evidence\n");
			return 74;
		}
		if (strcmp(status, "ok") != 0)
		{
			fprintf(stderr,
					"libpq latency probe failed in %s %s sample %" PRIu64
					" with status %s\n",
					options->mode_name, phase, index, status);
			return 1;
		}
	}
	return 0;
}

int
main(int argc, char **argv)
{
	struct options options;
	FILE *output;
	PGconn *persistent_connection = NULL;
	int status;

	if (!parse_options(argc, argv, &options))
	{
		usage(stderr, argv[0]);
		return 2;
	}
	output = fopen(options.output_path, "wx");
	if (output == NULL)
	{
		fprintf(stderr, "libpq latency probe could not create raw evidence output\n");
		return 73;
	}
	if (fprintf(output,
				"schema_version\tmode\tphase\tsample_index\tduration_ns\tstatus\n") < 0 ||
		fflush(output) != 0)
	{
		fprintf(stderr, "libpq latency probe could not write raw evidence header\n");
		(void) fclose(output);
		return 74;
	}

	if (options.mode == PROBE_MODE_PERSISTENT)
	{
		persistent_connection = PQconnectdb(options.conninfo);
		if (persistent_connection == NULL ||
			PQstatus(persistent_connection) != CONNECTION_OK)
		{
			(void) write_connection_failure(output, &options);
			if (persistent_connection != NULL)
				PQfinish(persistent_connection);
			(void) fclose(output);
			fprintf(stderr, "libpq latency probe could not establish persistent connection\n");
			return 1;
		}
	}

	status = run_phase(output, &options, persistent_connection, "warmup",
					   options.warmup_count);
	if (status == 0)
		status = run_phase(output, &options, persistent_connection, "measure",
						   options.sample_count);
	if (persistent_connection != NULL)
		PQfinish(persistent_connection);
	if (fclose(output) != 0 && status == 0)
	{
		fprintf(stderr, "libpq latency probe could not finalize raw evidence\n");
		status = 74;
	}
	return status;
}
