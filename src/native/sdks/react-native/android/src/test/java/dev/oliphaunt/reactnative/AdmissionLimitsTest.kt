package dev.oliphaunt.reactnative

import com.facebook.react.bridge.JavaOnlyMap
import dev.oliphaunt.AdmissionLimits
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class AdmissionLimitsTest {
  @Test
  fun omittedLimitsPreserveDefaultsAndExplicitLimitsReachKotlinWithoutClamping() {
    assertNull(JavaOnlyMap().admissionLimits())
    assertEquals(
      AdmissionLimits(65, 32L * 1024 * 1024),
      JavaOnlyMap.of("admissionMaxPendingOperations", 65.0, "admissionHighWaterMarkBytes", 32.0 * 1024 * 1024).admissionLimits(),
    )
    assertEquals(
      AdmissionLimits(Int.MAX_VALUE, 9_007_199_254_740_991L),
      JavaOnlyMap.of("admissionMaxPendingOperations", Int.MAX_VALUE.toDouble(), "admissionHighWaterMarkBytes", 9_007_199_254_740_991.0).admissionLimits(),
    )
  }

  @Test
  fun limitsRequireBothFieldsAndRejectLossyOrInvalidNumbers() {
    for (key in listOf("admissionMaxPendingOperations", "admissionHighWaterMarkBytes")) {
      assertThrows(IllegalArgumentException::class.java) { JavaOnlyMap.of(key, 1.0).admissionLimits() }
      for (invalid in listOf(null, 0.0, -1.0, 1.5, Double.NaN, Double.POSITIVE_INFINITY, 9_007_199_254_740_992.0, "1", true)) {
        val invalidConfig = JavaOnlyMap.of(
          "admissionMaxPendingOperations", if (key == "admissionMaxPendingOperations") invalid else 1.0,
          "admissionHighWaterMarkBytes", if (key == "admissionHighWaterMarkBytes") invalid else 8.0,
        )
        assertThrows(IllegalArgumentException::class.java) { invalidConfig.admissionLimits() }
      }
    }
    assertThrows(IllegalArgumentException::class.java) {
      JavaOnlyMap.of("admissionMaxPendingOperations", Int.MAX_VALUE.toDouble() + 1, "admissionHighWaterMarkBytes", 8.0).admissionLimits()
    }
  }
}
