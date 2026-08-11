package dev.oliphaunt.androidbrokerspike

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

internal class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val output = TextView(this).apply { text = "Android broker experiment running…" }
        setContentView(output)

        val runNonce = intent.getStringExtra("runNonce") ?: "manual-${System.currentTimeMillis()}"
        val strategy = intent.getStringExtra("strategy") ?: "full"
        scope.launch {
            val report =
                try {
                    withContext(Dispatchers.IO) {
                        BrokerExperiment(applicationContext).run(runNonce, strategy)
                    }
                } catch (error: Throwable) {
                    Log.e(TAG, "Android broker experiment failed", error)
                    JSONObject()
                        .put("schema", "oliphaunt-android-native-broker-spike-v1")
                        .put("status", "FAIL")
                        .put("runNonce", runNonce)
                        .put("strategy", strategy)
                        .put("error", error.causeChain())
                }
            publishReport(report)
            val encoded = report.toString()
            if (report.optString("status") == "PASS") {
                Log.i(TAG, "$JSON_MARKER$encoded")
                Log.i(TAG, PASS_MARKER)
                output.text = "PASS\n$encoded"
            } else {
                Log.e(TAG, "$JSON_MARKER$encoded")
                Log.e(TAG, FAIL_MARKER)
                output.text = "FAIL\n$encoded"
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun publishReport(report: JSONObject) {
        val destination = File(filesDir, REPORT_NAME)
        val temporary = File(filesDir, "$REPORT_NAME.tmp")
        FileOutputStream(temporary).use { stream ->
            stream.write(report.toString(2).toByteArray(Charsets.UTF_8))
            stream.write('\n'.code)
            stream.fd.sync()
        }
        check(temporary.renameTo(destination)) { "failed to publish $REPORT_NAME atomically" }
    }

    private companion object {
        const val TAG = "OliphauntBrokerSpike"
        const val REPORT_NAME = "android-broker-report.json"
        const val JSON_MARKER = "OLIPHAUNT_ANDROID_BROKER_JSON "
        const val PASS_MARKER = "OLIPHAUNT_ANDROID_BROKER_PASS"
        const val FAIL_MARKER = "OLIPHAUNT_ANDROID_BROKER_FAIL"
    }
}

private fun Throwable.causeChain(): String {
    val seen = mutableSetOf<Throwable>()
    val parts = mutableListOf<String>()
    var current: Throwable? = this
    while (current != null && seen.add(current) && parts.size < 8) {
        parts += "${current.javaClass.simpleName}: ${current.message ?: "unknown failure"}"
        current = current.cause
    }
    return parts.joinToString(" <- ").take(2_048)
}
