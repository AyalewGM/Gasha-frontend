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
from uuid import UUID, uuid4

BACKEND = Path(os.environ.get("GASHA_MVE_BACKEND", "backend")).resolve()
sys.path[:0] = [str(BACKEND / "tests"), str(BACKEND / "src")]

import psycopg
from psycopg import sql

import test_postgres_evaluation_alerts as alerts
import test_postgres_synthetic_fraud_workflow as workflow
from test_kafka_ingestion import FakeRecord, make_consumer
from test_postgres_case_writer_bridge import (
    ASSIGNEE, CAPABILITIES, connect, principal,
)
from test_postgres_evaluations import POLICY
from test_postgres_shadow_copy_mve import TENANT, _synthetic_copy
from test_postgres_shadow_feature_recovery import (
    SyntheticFixtures, snapshot_for_copy,
)

from gasha.api.main import app
from gasha.cases.evaluation_alerts import PostgresEvaluationAlertWriter, evaluation_context_ref
from gasha.cases.postgres_feature_view import ExplicitPostgresCaseFeatureReader
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
from gasha.intelligence.synthetic_shadow_provider import SyntheticShadowWorkerEvaluator
from gasha.orchestration import ShadowOrchestrator
from gasha.postgres_evaluations import PostgresEvaluationPersistence, PostgresShadowEvaluationRepository
from gasha.security.access import Capability, CredentialRejected
from gasha.security.postgres_audit import PostgresSecurityAuditSink


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
    with psycopg.connect(dsn, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(name)))
    try:
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
                    orchestrator,
                    history_source=SyntheticFixtures((
                        snapshot_for_copy(first), snapshot_for_copy(second),
                    )),
                ),
                pending=PostgresPendingEvaluationStore(
                    db, tenant_ids=(TENANT,), worker_id="browser-mve-recovered",
                ),
                worker_id="browser-mve-recovered", tenant_ids=(TENANT,),
                dead_letters=recovered_dlq,
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
        path.write_text(json.dumps(manifest))
        path.chmod(0o600)
        print("SYNTHETIC_SEED_OK alerts=2 founding_cases=1 pending=0", flush=True)
    except BaseException:
        drop(name)
        raise


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
    def resolve(self, *, principal, tenant_id, selector, at):
        if tenant_id != TENANT or tenant_id not in principal.tenant_ids or selector != ASSIGNEE:
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
        assignees=LabAssignees(),
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
        operations = [json.loads(row["event_json"])["operation"] for row in rows]
        assert operations == ["create", "triage", "assign", "dispose", "reconcile"]
        assert all(
            json.loads(row["event_json"])["bank_execution"] == "unknown"
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
    print(
        "SYNTHETIC_VERIFY_OK alerts=2 founding_cases=1 "
        "case_revisions=5 pending=0 enforcement_activated=false "
        "bank_execution=unknown",
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
