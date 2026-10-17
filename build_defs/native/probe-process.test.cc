#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

#include "autoconf/private/checker/native_process.h"

#define CHECK(expression) do { if (!(expression)) { \
    std::cerr << "failed: " << #expression << '\n'; return 2; \
} } while (false)

int main(int argc, char** argv) {
    if (argc > 1) {
        std::string mode = argv[1];
        if (mode == "exit") return std::stoi(argv[2]);
        if (mode == "echo") {
            for (int index = 2; index < argc; ++index) std::cout << argv[index] << '\n';
            return 0;
        }
#ifndef _WIN32
        if (mode == "signal") std::raise(SIGTERM);
#endif
        return 3;
    }
    using rules_cc_autoconf::run_native_process;
    auto executable = std::filesystem::absolute(argv[0]).string();
    CHECK(run_native_process({executable, "exit", "0"}) == 0);
    CHECK(run_native_process({executable, "exit", "1"}) == 1);

    auto rejects = [&](const std::vector<std::string>& arguments) {
        bool failed = false;
        try { run_native_process(arguments); }
        catch (const std::exception&) { failed = true; }
        return failed;
    };
    CHECK(rejects({}));
    CHECK(rejects({executable + "-missing"}));
    bool bypassed_optional_result = false;
    try { run_native_process({executable + "-missing"}); }
    catch (const std::runtime_error&) { return 2; }
    catch (const std::exception&) { bypassed_optional_result = true; }
    CHECK(bypassed_optional_result);
#ifndef _WIN32
    CHECK(rejects({executable, "signal"}));
    CHECK(rejects({executable, "exit", "126"}));
    CHECK(rejects({executable, "exit", "127"}));
#endif

    auto temporary = std::getenv("TEST_TMPDIR");
    CHECK(temporary);
    auto output = (std::filesystem::path(temporary) / "literal args output.txt").string();
    std::vector<std::string> literals = {"", "a b", "x\\", "a\"b", "'$();&<>%", "trailing \\"};
    std::vector<std::string> command = {executable, "echo"};
    command.insert(command.end(), literals.begin(), literals.end());
    CHECK(run_native_process(command, true, output) == 0);
    std::ifstream input(output);
    std::string actual((std::istreambuf_iterator<char>(input)), {});
    std::string expected;
    for (const auto& value : literals) expected += value + '\n';
    CHECK(actual == expected);
    bool unwritable_failed = false;
    try { run_native_process(command, true, output + "/missing/out.txt"); }
    catch (const std::exception&) { unwritable_failed = true; }
    CHECK(unwritable_failed);
    return 0;
}
