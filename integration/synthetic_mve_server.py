"""Offline #9 cross-repository synthetic UC-02 fixture, never an installed Bank service.

This runner MUST be executed only with disposable PostgreSQL and loopback
FastAPI/Vite. Its fixture verifier is explicitly synthetic; the default
protected API remains unconfigured and the Bank session getter stays null.
"""
from __future__ import annotations

import argparse
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from hashlib import sha256
import json
import os
from pathlib import Path
from secrets import token_urlsafe
import sys
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from redis import Redis

BACKEND = Path(os.environ.get("GASHA_MVE_BACKEND", "backend")).resolve()
sys.path[:0] = [str(BACKEND / "tests"), str(BACKEND / "src")]

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict

import test_postgres_evaluation_alerts as alerts
import test_postgres_synthetic_fraud_workflow as workflow
from test_kafka_ingestion import FakeRecord, make_consumer
from test_postgres_case_writer_bridge import (
    ASSIGNEE, CAPABILITIES, connect, principal,
)
from test_postgres_evaluations import POLICY
from test_postgres_shadow_copy_mve import TENANT, _synthetic_copy

from gasha.api.main import app
from gasha.cases.evaluation_alerts import PostgresEvaluationAlertWriter, evaluation_context_ref
from gasha.cases.metrics import CaseMetricsRejected, SyntheticAlertClock, summarize_synthetic_case_metrics
from gasha.cases.postgres_feature_view import ExplicitPostgresCaseFeatureReader
from gasha.cases.postgres_timeline import PostgresCaseTimelineService
from gasha.cases.postgres_history_reader import ExplicitPostgresCaseHistoryReader
from gasha.cases.postgres_queue_reader import ExplicitPostgresCaseQueueReader
from gasha.cases.postgres_writer_bridge import ExplicitPostgresCaseTransitionWriter
from gasha.cases.synthetic_ranking import SyntheticPostgresRankingSource
from gasha.cases.timeline import AuthorizedAssignee, VerifiedEvaluation
from gasha.ingestion.contracts import FraudEventEnvelope
from gasha.ingestion.postgres_store import PostgresPendingEvaluationStore
from gasha.ingestion.service import IngestionService
from gasha.ingestion.shadow_copy import SyntheticShadowCopyAdapter
from gasha.ingestion.worker import IngestionWorker
from gasha.intelligence.feature_set_v1 import ObservedTransfer
from gasha.intelligence.internal_graph import InternalGraphPolicy
from gasha.intelligence.redis_feature_history import RedisFeatureHistory
from gasha.intelligence.synthetic_shadow_provider import (
    RedisSyntheticHistorySource, SyntheticShadowWorkerEvaluator,
)
from gasha.orchestration import ShadowOrchestrator
from gasha.postgres_evaluations import PostgresEvaluationPersistence, PostgresShadowEvaluationRepository
from gasha.security.access import Capability, CredentialRejected
from gasha.security.postgres_audit import PostgresSecurityAuditSink


def require_disposable_db() -> None:
    """Refuse non-loopback or unrecognized database targets before any SQL."""
    dsn = os.environ.get("GASHA_TEST_POSTGRES_DSN")
    if not dsn:
        raise RuntimeError("disposable PostgreSQL connection required")
    try:
        target = conninfo_to_dict(dsn)
    except Exception as exc:
        raise RuntimeError("invalid disposable PostgreSQL target") from exc
    database = target.get("dbname", "")
    if (
        target.get("host") not in {"127.0.0.1", "localhost", "::1"}
        or not (database == "gasha_test" or database.startswith("gasha_mve_"))
        or target.get("hostaddr", "") not in {"", "127.0.0.1", "::1"}
    ):
        raise RuntimeError("refusing non-loopback or non-disposable PostgreSQL target")


def require_disposable_redis() -> str:
    """Reject non-loopback, non-disposable Redis endpoints before use."""
    endpoint = os.environ.get("GASHA_TEST_REDIS_URL", "")
    try:
        parsed = urlsplit(endpoint)
        accepted = (
            parsed.scheme == "redis"
            and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
            and parsed.port == 6379 and parsed.path == "/15"
            and parsed.username is None and parsed.password is None
            and not parsed.query and not parsed.fragment
        )
    except ValueError:
        accepted = False
    if not accepted:
        raise RuntimeError("refusing non-loopback/non-disposable Redis target")
    return endpoint


def settings(path: Path) -> dict[str, str]:
    value = json.loads(path.read_text())
    if value.get("scenario") != "uc02":
        raise RuntimeError("unsupported synthetic scenario")
    return value


def seed(path: Path, scenario: str) -> None:
    if scenario != "uc02":
        raise RuntimeError("only UC-02 has a reviewed fixture; do not invent other signals")
    if not os.environ.get("GASHA_TEST_POSTGRES_DSN"):
        raise RuntimeError("disposable PostgreSQL DSN required")
    if path.exists():
        raise RuntimeError("fresh manifest path required")
    name = "gasha_browser_" + uuid4().hex[:14]
    dsn = os.environ["GASHA_TEST_POSTGRES_DSN"]
    redis_url = require_disposable_redis()
    with psycopg.connect(dsn, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(name)))
    redis_client = Redis.from_url(redis_url, socket_timeout=2, socket_connect_timeout=2)
    try:
        assert redis_client.ping(), "synthetic Redis unavailable"
        migrations = (
            "010_security_audit_events.sql", "011_analyst_case_events.sql",
            "001_create_fraud_decision_audit.sql", "003_create_shadow_evaluations.sql",
            "017_evaluation_alerts.sql", "018_alert_policy_provenance.sql",
            "019_shadow_evaluation_immutability.sql", "005_create_dead_letters.sql",
            "007_create_pending_evaluations.sql", "008_pending_lease_fencing.sql",
            "009_pending_terminal_state.sql", "020_pending_adapter_contract.sql",
        )
        with connect(name) as db:
            for version in migrations:
                db.execute((alerts.MIGRATIONS / version).read_text())
        alerts.install_policy(name, workflow.ALERT_POLICY)
        first, second = _synthetic_copy(), _synthetic_copy()
        assert first.source_system == second.source_system == "synthetic-shadow-copy"
        assert first.payload["beneficiary_id"] == second.payload["beneficiary_id"]
        assert first.received_at == second.received_at
        occurred = datetime.fromisoformat(str(first.payload["occurred_at"]))
        redis_history = RedisFeatureHistory(
            redis_client, tenant_id=TENANT, epoch=uuid4().hex,
        )
        redis_history.open_epoch(
            covered_from=occurred - timedelta(hours=1), ttl_seconds=300,
        )
        for n in range(1, 6):
            prior_time = occurred - timedelta(minutes=n)
            assert redis_history.append(ObservedTransfer(
                TENANT, f"prior-{n}", f"sender-{n}",
                str(first.payload["beneficiary_id"]), None, prior_time, prior_time,
            ))
        history_source = RedisSyntheticHistorySource(
            redis_history,
            tenant_id=TENANT,
            source_system=first.source_system,
            graph_policy=InternalGraphPolicy(policy_version="synthetic-graph-v1"),
        )
        consumer, batch, dead_letters = make_consumer([
            FakeRecord(json.dumps(first.model_dump(mode="json")).encode(), 1),
            FakeRecord(json.dumps(second.model_dump(mode="json")).encode(), 2),
            FakeRecord(json.dumps(first.model_dump(mode="json")).encode(), 3),
        ])

        def unavailable(_event: FraudEventEnvelope, _policy=None):
            raise TimeoutError("synthetic worker unavailable after transport ACK")

        with connect(name) as db:
            failed = IngestionWorker(
                consumer,
                IngestionService(
                    {"synthetic-shadow-copy": SyntheticShadowCopyAdapter()},
                    dead_letters=dead_letters,
                ),
                evaluate=unavailable,
                pending=PostgresPendingEvaluationStore(
                    db, tenant_ids=(TENANT,), worker_id="browser-mve-failed",
                ),
                policy_for=lambda _tenant: POLICY,
                worker_id="browser-mve-failed", tenant_ids=(TENANT,),
                retry_backoff=timedelta(0), dead_letters=dead_letters,
            )
            assert failed.run_once(max_events=3) == 3
            assert batch.commits == 1 and not dead_letters.records
            assert db.execute("SELECT count(*) AS n FROM pending_evaluations").fetchone()["n"] == 2

        recovered_consumer, recovered_batch, recovered_dlq = make_consumer([])
        with connect(name) as db:
            writer = PostgresEvaluationAlertWriter(
                TENANT, workflow.ALERT_POLICY,
                principal(caps=frozenset({Capability.CASE_CREATE})),
            )
            orchestrator = ShadowOrchestrator(
                {TENANT: POLICY},
                persistence=PostgresEvaluationPersistence(
                    db, tenant_ids=(TENANT,), require_lease=True, alerts=writer,
                ),
            )
            recovered = IngestionWorker(
                recovered_consumer,
                IngestionService({"synthetic-shadow-copy": SyntheticShadowCopyAdapter()}),
                evaluate=SyntheticShadowWorkerEvaluator(
                    orchestrator, history_source=history_source,
                ),
                pending=PostgresPendingEvaluationStore(
                    db, tenant_ids=(TENANT,), worker_id="browser-mve-recovered",
                ),
                worker_id="browser-mve-recovered", tenant_ids=(TENANT,),
                retry_backoff=timedelta(0), max_evaluation_attempts=4,
                dead_letters=recovered_dlq,
            )
            # Unsealed Redis cannot authorize even one shadow evidence write.
            assert recovered.run_once(max_events=1) == 0
            assert db.execute(
                "SELECT count(*) AS n FROM pending_evaluations"
            ).fetchone()["n"] == 2
            for table in (
                "shadow_evaluations", "evaluation_alerts",
                "analyst_case_events", "fraud_decision_audit",
                "security_audit_events",
            ):
                assert db.execute(
                    f"SELECT count(*) AS n FROM {table}"
                ).fetchone()["n"] == 0, "unsealed Redis committed evidence"
            redis_history.seal(
                available_through=max(first.received_at, second.received_at),
            )
            assert recovered.run_once(max_events=1) == 0
            assert recovered.run_once(max_events=1) == 0
            assert recovered_batch.commits == 0 and not recovered_dlq.records
            counts = {table: db.execute(
                f"SELECT count(*) AS n FROM {table}"
            ).fetchone()["n"] for table in (
                "shadow_evaluations", "evaluation_alerts",
                "analyst_case_events", "fraud_decision_audit",
            )}
            assert counts == {
                "shadow_evaluations": 2, "evaluation_alerts": 2,
                "analyst_case_events": 1, "fraud_decision_audit": 2,
            }, counts
            assert db.execute(
                "SELECT count(*) AS n FROM pending_evaluations"
            ).fetchone()["n"] == 0
            assert db.execute(
                "SELECT count(*) AS n FROM security_audit_events "
                "WHERE action='alert.generate'"
            ).fetchone()["n"] == 2
            recorded_alerts = db.execute(
                "SELECT event_id, case_id FROM evaluation_alerts"
            ).fetchall()
            assert len(recorded_alerts) == 2
            assert len({a["case_id"] for a in recorded_alerts}) == 1
            for item in recorded_alerts:
                saved = PostgresShadowEvaluationRepository(
                    db, tenant_ids=(TENANT,),
                ).get(TENANT, UUID(str(item["event_id"])))
                assert saved is not None and saved.feature_evidence is not None
                assert saved.feature_evidence.eligible_observations == 5
                assert "sender_beneficiary_history_coverage" in (
                    saved.feature_evidence.unavailable_signals
                )
            # Empty-consumer replay cannot generate duplicate alerts or audit.
            assert recovered.run_once(max_events=1) == 0
            assert db.execute(
                "SELECT count(*) AS n FROM security_audit_events "
                "WHERE action='alert.generate'"
            ).fetchone()["n"] == 2
            founder = db.execute(
                "SELECT case_id, source_event_id, source_context_ref "
                "FROM analyst_case_events WHERE revision=1"
            ).fetchone()
            assert founder
        token = token_urlsafe(32)
        manifest = {
            "scenario": scenario, "schema": name,
            "token": token,
            "foreign_token": token_urlsafe(32),
            "no_read_token": token_urlsafe(32),
            "expired_token": token_urlsafe(32),
            "revoked_token": token_urlsafe(32),
            "assignee": str(ASSIGNEE), "case": str(founder["case_id"]),
            "source_event": str(founder["source_event_id"]),
            "source_context": founder["source_context_ref"],
            "backend_sha": os.environ.get("GASHA_MVE_BACKEND_SHA", "unknown"),
            "initial_alerts": 2,
        }
        # Establish 0600 at exclusive creation, BEFORE writing test tokens.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as private_file:
            json.dump(manifest, private_file)
        if path.stat().st_mode & 0o777 != 0o600:
            raise RuntimeError("synthetic credential manifest has unsafe file mode")
        print(
            "SYNTHETIC_SEED_OK redis_sealed=true eligible_observations=5 "
            "alerts=2 founding_cases=1 pending=0", flush=True,
        )
    except BaseException:
        path.unlink(missing_ok=True)
        drop(name)
        raise
    finally:
        redis_client.close()


def drop(name: str) -> None:
    if not name.startswith("gasha_browser_"):
        raise RuntimeError("refusing cleanup outside disposable browser schema")
    with psycopg.connect(os.environ["GASHA_TEST_POSTGRES_DSN"], autocommit=True) as db:
        db.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(name)))


class LabIdentity:
    def __init__(self, manifest: dict[str, str]) -> None:
        self.manifest = manifest

    def verify(self, bearer: str):
        values = self.manifest
        capabilities = CAPABILITIES | {Capability.CASE_READ}
        if bearer == values["token"]:
            return principal(caps=capabilities)
        if bearer == values["foreign_token"]:
            return principal(tenant="tenant-b", caps=capabilities)
        if bearer == values["no_read_token"]:
            return principal(caps=frozenset({Capability.CASE_TRIAGE}))
        if bearer == values["expired_token"]:
            return replace(
                principal(caps=capabilities), expires_at=datetime.now(UTC) - timedelta(seconds=1),
            )
        raise CredentialRejected("unrecognized or revoked synthetic credential")


class EvaluationDirectory:
    def __init__(self, schema: str) -> None:
        self.schema = schema

    def resolve(self, *, principal, tenant_id, event_id, at):
        if tenant_id != TENANT or tenant_id not in principal.tenant_ids:
            raise LookupError("synthetic evaluation not authorized")
        with connect(self.schema) as db:
            record = PostgresShadowEvaluationRepository(
                db, tenant_ids=(TENANT,),
            ).get(tenant_id, event_id)
        if record is None or record.persisted_at > at:
            raise LookupError("synthetic evaluation unavailable")
        return VerifiedEvaluation(tenant_id, event_id, evaluation_context_ref(record))


class LabAssignees:
    def __init__(self, selector: UUID) -> None:
        self.selector = selector

    def resolve(self, *, principal, tenant_id, selector, at):
        if tenant_id != TENANT or tenant_id not in principal.tenant_ids or selector != self.selector:
            raise LookupError("unknown synthetic assignee")
        return AuthorizedAssignee(TENANT, principal.audit_actor)


def serve(manifest: dict[str, str], port: int) -> None:
    import uvicorn

    schema = manifest["schema"]
    def connections():
        return connect(schema)

    app.state.identity_verifier = LabIdentity(manifest)
    app.state.security_audit = PostgresSecurityAuditSink(connections=connections)
    app.state.case_queue_reader = ExplicitPostgresCaseQueueReader(
        connections=connections,
        ranking=SyntheticPostgresRankingSource(
            connections=connections, tenant_id=TENANT,
            alert_policies=(workflow.ALERT_POLICY,),
        ),
    )
    app.state.case_history_reader = ExplicitPostgresCaseHistoryReader(connections=connections)
    app.state.case_feature_reader = ExplicitPostgresCaseFeatureReader(connections=connections)
    app.state.case_transition_writer = ExplicitPostgresCaseTransitionWriter(
        connections=connections,
        evaluations=EvaluationDirectory(schema),
        assignees=LabAssignees(UUID(manifest["assignee"])),
    )
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="error", access_log=False)


def audit_fault(schema: str, enabled: bool) -> None:
    with connect(schema) as db:
        if enabled:
            db.execute(
                "ALTER TABLE security_audit_events ADD CONSTRAINT "
                "browser_mve_audit_outage CHECK (action <> 'authenticate') NOT VALID"
            )
        else:
            db.execute(
                "ALTER TABLE security_audit_events DROP CONSTRAINT "
                "IF EXISTS browser_mve_audit_outage"
            )


def verify(manifest: dict[str, str]) -> None:
    name = manifest["schema"]
    with connect(name) as db:
        values = {table: db.execute(
            f"SELECT count(*) AS n FROM {table}"
        ).fetchone()["n"] for table in (
            "pending_evaluations", "shadow_evaluations",
            "evaluation_alerts", "analyst_case_events",
            "fraud_decision_audit", "security_audit_events",
        )}
        assert values["pending_evaluations"] == 0
        assert values["shadow_evaluations"] == 2
        assert values["evaluation_alerts"] == 2
        assert values["fraud_decision_audit"] == 2
        assert values["analyst_case_events"] == 5, values
        rows = db.execute(
            "SELECT event_json FROM analyst_case_events ORDER BY revision"
        ).fetchall()
        operations = [row["event_json"]["operation"] for row in rows]
        assert operations == ["create", "triage", "assign", "dispose", "reconcile"]
        assert all(
            row["event_json"]["bank_execution"] == "unknown"
            for row in rows
        )
        rows = db.execute(
            "SELECT action, result, actor_ref, tenant_ref, context_ref "
            "FROM security_audit_events"
        ).fetchall()
        assert any(r["action"] == "case.read" and r["result"] == "succeeded" for r in rows)
        assert all(
            r["tenant_ref"] and len(r["tenant_ref"]) == 64 and
            manifest["token"] not in str(r) and
            TENANT not in str(r)
            for r in rows
        )
    # KPI-like engineering evidence is computed from re-read durable synthetic
    # history and recorded source/alert clocks, never Bank data or labels.
    print("SYNTHETIC_INTERNAL_BEFORE_HISTORY", flush=True)
    clock_at = datetime.now(UTC)
    with connect(name) as db:
        history = PostgresCaseTimelineService(db).history(
            principal=principal(caps=CAPABILITIES | {Capability.CASE_READ}),
            tenant_id=TENANT, case_id=UUID(manifest["case"]), at=clock_at,
        )
    print("SYNTHETIC_INTERNAL_AFTER_HISTORY", flush=True)
    with connect(name) as db:
        source_alert = db.execute(
            "SELECT event_id, generated_at FROM evaluation_alerts "
            "WHERE tenant_id=%s AND event_id=%s",
            (TENANT, manifest["source_event"]),
        ).fetchone()
        assert source_alert is not None
        source_record = PostgresShadowEvaluationRepository(
            db, tenant_ids=(TENANT,),
        ).get(TENANT, UUID(manifest["source_event"]))
        assert source_record is not None and source_record.feature_evidence is not None
        evidence = source_record.feature_evidence
        assert evidence.eligible_observations == 5, "redis_observation_count"
        assert "sender_beneficiary_history_coverage" in evidence.unavailable_signals, (
            "lifetime_relationship_absence_must_remain_unavailable"
        )
    print("SYNTHETIC_INTERNAL_AFTER_SOURCE", flush=True)
    try:
        summary = summarize_synthetic_case_metrics(
            tenant_id=TENANT, histories=(history,), as_of=clock_at,
            alert_clocks=(SyntheticAlertClock(
                TENANT, UUID(manifest["case"]), UUID(manifest["source_event"]),
                source_record.event.canonical_transaction.occurred_at.astimezone(UTC),
                source_alert["generated_at"].astimezone(UTC),
            ),),
        )
    except CaseMetricsRejected as exc:
        # Emit only a constant known failure category, never data or timestamps.
        failure_codes = {
            "unknown, duplicate or impossible alert timing": "TIMING",
            "alert cannot precede source event": "CLOCK_ORDER",
            "future-dated case history": "HISTORY_CLOCK",
            "timezone-aware trusted timestamp required": "CLOCK_TYPE",
            "duplicate case or source evaluation": "SOURCE_REUSE",
            "invalid duration coverage accounting": "COVERAGE",
            "invalid synthetic metric scope or ambiguous/corrupt history": "SCOPE",
        }
        print("SYNTHETIC_INTERNAL_CAUSE_" +
              failure_codes.get(str(exc), "OTHER"), flush=True)
        raise
    print("SYNTHETIC_INTERNAL_AFTER_AGGREGATION", flush=True)
    # Unresolved is the only justified disposition for this unlabelled fixture.
    # Re-read revision 4 directly: no test-only fake response or write.
    with connect(name) as db:
        disposition = db.execute(
            "SELECT event_json->>'disposition' AS label "
            "FROM analyst_case_events WHERE revision=4"
        ).fetchone()
    assert disposition and disposition["label"] == "unresolved", "metrics_disposition"
    assert summary["counts"]["unresolved"] == 1, "metrics_unresolved"
    assert summary["counts"]["confirmed_fraud"] == 0, "metrics_confirmed_fraud"
    assert summary["counts"]["confirmed_legitimate"] == 0, "metrics_confirmed_legitimate"
    assert summary["counts"]["reconciled"] == 1, "metrics_reconciled"
    assert summary["counts"]["feedback_pending"] == 0, "metrics_feedback_pending"
    assert summary["counts"]["open_investigations"] == 0, "metrics_open"
    assert summary["alert_latency"]["count"] == 1, "metrics_alert_latency"
    assert summary["investigation_turnaround"]["count"] == 1, "metrics_turnaround"
    assert summary["bank_operational_kpi_authorized"] is False, "metrics_bank_authority"
    assert summary["enforcement_activated"] is False, "metrics_enforcement"
    print(
        "SYNTHETIC_VERIFY_OK redis_derived=true eligible_observations=5 "
        "lifetime_history=unavailable alerts=2 founding_cases=1 "
        "case_revisions=5 pending=0 disposition=unresolved "
        "enforcement_activated=false bank_execution=unknown",
        flush=True,
    )


def main() -> None:
    cli = argparse.ArgumentParser()
    cli.add_argument("action", choices=[
        "seed", "serve", "verify", "audit-deny", "audit-restore", "cleanup",
    ])
    cli.add_argument("--manifest", type=Path, required=True)
    cli.add_argument("--scenario", default="uc02")
    cli.add_argument("--port", type=int, default=8000)
    args = cli.parse_args()
    require_disposable_db()
    if args.action == "seed":
        seed(args.manifest, args.scenario)
    else:
        manifest = settings(args.manifest)
        if args.action == "serve":
            serve(manifest, args.port)
        elif args.action == "verify":
            verify(manifest)
        elif args.action in ("audit-deny", "audit-restore"):
            audit_fault(manifest["schema"], args.action == "audit-deny")
        elif args.action == "cleanup":
            drop(manifest["schema"])
            args.manifest.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
