"""Regression tests for Storage-owned public reference codes."""

import unittest

from promptcard_storage.reference_codes import (
    ReferenceCodeError,
    ReferenceNamespace,
    generate_reference_code,
    parse_reference_code,
)


class ParseReferenceCodeTests(unittest.TestCase):
    def test_all_prefixes_canonicalize_case_without_cross_namespace_routing(self):
        # Catches a parser that accepts only one namespace or fails to uppercase output.
        cases = (
            ("prj-01arz3ndektsv4rrffq69g5fav", ReferenceNamespace.PROJECT),
            ("plp-01arz3ndektsv4rrffq69g5fav", ReferenceNamespace.PROMPT_BUNDLE),
            ("plm-01arz3ndektsv4rrffq69g5fav", ReferenceNamespace.PROMPT_MEDIA),
            ("cvt-01arz3ndektsv4rrffq69g5fav", ReferenceNamespace.CANVAS_TEMPLATE),
            ("cvm-01arz3ndektsv4rrffq69g5fav", ReferenceNamespace.CANVAS_MEDIA),
            ("cvc-01arz3ndektsv4rrffq69g5fav", ReferenceNamespace.CANVAS_CONTEXT),
            ("skl-01arz3ndektsv4rrffq69g5fav", ReferenceNamespace.SKILL),
        )

        for supplied, expected_namespace in cases:
            with self.subTest(supplied=supplied):
                parsed = parse_reference_code(supplied)
                self.assertEqual(expected_namespace, parsed.namespace)
                self.assertEqual(supplied.upper(), parsed.code)

    def test_each_prohibited_crockford_letter_has_stable_error_code(self):
        # Catches accepting any ambiguous Crockford letter, not only I.
        cases = (
            "PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAI",
            "PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAL",
            "PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAO",
            "PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAU",
        )

        for supplied in cases:
            with self.subTest(supplied=supplied):
                with self.assertRaisesRegex(
                    ReferenceCodeError, "invalid_reference_code_alphabet"
                ) as caught:
                    parse_reference_code(supplied)

                self.assertEqual("invalid_reference_code_alphabet", caught.exception.code)

    def test_wrong_length_has_stable_error_code(self):
        # Catches accepting a truncated public code that cannot identify a ULID.
        with self.assertRaisesRegex(ReferenceCodeError, "invalid_reference_code_length") as caught:
            parse_reference_code("PRJ-01ARZ3NDEKTSV4RRFFQ69G5FA")

        self.assertEqual("invalid_reference_code_length", caught.exception.code)

    def test_overflow_ulid_has_stable_error_code(self):
        # Catches accepting 130-bit base32 values outside the ULID's 128-bit range.
        with self.assertRaisesRegex(ReferenceCodeError, "invalid_reference_code_overflow") as caught:
            parse_reference_code("CVC-Z1ARZ3NDEKTSV4RRFFQ69G5FAV")

        self.assertEqual("invalid_reference_code_overflow", caught.exception.code)

    def test_expected_namespace_mismatch_has_stable_error_code(self):
        # Catches resolving a valid prompt-media code as canvas media by skipping prefix dispatch.
        with self.assertRaisesRegex(ReferenceCodeError, "reference_namespace_mismatch") as caught:
            parse_reference_code(
                "PLM-01ARZ3NDEKTSV4RRFFQ69G5FAV",
                expected_namespace=ReferenceNamespace.CANVAS_MEDIA,
            )

        self.assertEqual("reference_namespace_mismatch", caught.exception.code)


class GenerateReferenceCodeTests(unittest.TestCase):
    def test_fixed_timestamp_and_entropy_generate_reproducible_canonical_code(self):
        # Catches a generator that ignores its deterministic sources or emits lowercase output.
        code = generate_reference_code(
            ReferenceNamespace.PROJECT,
            timestamp_ms=0,
            entropy_source=lambda: b"\x00" * 10,
        )

        self.assertEqual("PRJ-00000000000000000000000000", code)

    def test_maximum_timestamp_and_entropy_preserve_the_ulid_bit_boundary(self):
        # Catches a wrong timestamp shift or an overlap between timestamp and entropy bits.
        code = generate_reference_code(
            ReferenceNamespace.PROJECT,
            timestamp_ms=281474976710655,
            entropy_source=lambda: b"\xff" * 10,
        )

        self.assertEqual("PRJ-7ZZZZZZZZZZZZZZZZZZZZZZZZZ", code)

    def test_prefix_dispatch_keeps_canvas_media_separate_from_prompt_media(self):
        # Catches a generator that conflates PLM and CVM namespaces.
        code = generate_reference_code(
            "cvm",
            timestamp_ms=0,
            entropy_source=lambda: b"\x00" * 10,
        )

        self.assertEqual("CVM-00000000000000000000000000", code)

    def test_collision_predicate_retries_with_next_entropy_without_replacing_ids(self):
        # Catches returning a known collision instead of regenerating a new public reference.
        entropy_values = iter((b"\x00" * 10, b"\xff" * 10))
        seen = []

        def is_collision(code):
            seen.append(code)
            return code == "SKL-00000000000000000000000000"

        code = generate_reference_code(
            ReferenceNamespace.SKILL,
            timestamp_ms=0,
            entropy_source=lambda: next(entropy_values),
            collision_predicate=is_collision,
        )

        self.assertEqual("SKL-0000000000ZZZZZZZZZZZZZZZZ", code)
        self.assertEqual(
            [
                "SKL-00000000000000000000000000",
                "SKL-0000000000ZZZZZZZZZZZZZZZZ",
            ],
            seen,
        )

    def test_continuous_collisions_stop_after_sixteen_attempts(self):
        # Catches an unbounded collision loop or an attempt budget that silently changes.
        attempts = []

        def is_collision(code):
            attempts.append(code)
            return True

        with self.assertRaisesRegex(ReferenceCodeError, "reference_code_collision") as caught:
            generate_reference_code(
                ReferenceNamespace.SKILL,
                timestamp_ms=0,
                entropy_source=lambda: b"\x00" * 10,
                collision_predicate=is_collision,
            )

        self.assertEqual("reference_code_collision", caught.exception.code)
        self.assertEqual(16, len(attempts))


if __name__ == "__main__":
    unittest.main()
