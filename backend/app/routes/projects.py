from __future__ import annotations

from datetime import datetime, timezone
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.db import get_db
from app.models import Project, ProjectType, User
from app.schemas.projects import (
    ProjectCreate,
    ProjectResponse,
    ProjectTypeCreate,
    ProjectTypeResponse,
    ProjectTypeUpdate,
    ProjectUpdate,
)

router = APIRouter(prefix="/projects", tags=["projects"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _project_type_to_response(row: ProjectType) -> ProjectTypeResponse:
    return ProjectTypeResponse(
        id=row.id,
        user_id=row.user_id,
        name=row.name,
        system_prompt_template=row.system_prompt_template,
        memory_strategy=row.memory_strategy or {},
        features=row.features or {},
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _project_to_response(row: Project) -> ProjectResponse:
    return ProjectResponse(
        id=row.id,
        user_id=row.user_id,
        name=row.name,
        project_type_id=row.project_type_id,
        context_doc=row.context_doc or {},
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _get_project_type_or_404(db: AsyncSession, user_id: str, project_type_id: str) -> ProjectType:
    result = await db.execute(
        select(ProjectType).where(ProjectType.user_id == user_id, ProjectType.id == project_type_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Project type not found")
    return row


async def _get_project_or_404(db: AsyncSession, user_id: str, project_id: str) -> Project:
    result = await db.execute(
        select(Project).where(Project.user_id == user_id, Project.id == project_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    return row


@router.post("/types", response_model=ProjectTypeResponse)
async def create_project_type(
    req: ProjectTypeCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    now = _now()
    row = ProjectType(
        id=str(uuid.uuid4()),
        user_id=user.id,
        name=req.name.strip(),
        system_prompt_template=req.system_prompt_template,
        memory_strategy=req.memory_strategy,
        features=req.features,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _project_type_to_response(row)


@router.get("/types", response_model=list[ProjectTypeResponse])
async def list_project_types(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ProjectType).where(ProjectType.user_id == user.id).order_by(ProjectType.updated_at.desc())
    )
    return [_project_type_to_response(x) for x in result.scalars().all()]


@router.put("/types/{project_type_id}", response_model=ProjectTypeResponse)
async def update_project_type(
    project_type_id: str,
    req: ProjectTypeUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_project_type_or_404(db, user.id, project_type_id)
    patch = req.model_dump(exclude_unset=True)
    if "name" in patch and patch["name"] is not None:
        row.name = patch["name"].strip()
    if "system_prompt_template" in patch and patch["system_prompt_template"] is not None:
        row.system_prompt_template = patch["system_prompt_template"]
    if "memory_strategy" in patch and patch["memory_strategy"] is not None:
        row.memory_strategy = patch["memory_strategy"]
    if "features" in patch and patch["features"] is not None:
        row.features = patch["features"]
    row.updated_at = _now()
    await db.commit()
    await db.refresh(row)
    return _project_type_to_response(row)


@router.delete("/types/{project_type_id}")
async def delete_project_type(
    project_type_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_project_type_or_404(db, user.id, project_type_id)
    await db.delete(row)
    await db.commit()
    return {"ok": True}


@router.post("", response_model=ProjectResponse)
async def create_project(
    req: ProjectCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if req.project_type_id:
        await _get_project_type_or_404(db, user.id, req.project_type_id)
    now = _now()
    row = Project(
        id=str(uuid.uuid4()),
        user_id=user.id,
        name=req.name.strip(),
        project_type_id=req.project_type_id,
        context_doc=req.context_doc,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _project_to_response(row)


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Project).where(Project.user_id == user.id).order_by(Project.updated_at.desc())
    )
    return [_project_to_response(x) for x in result.scalars().all()]


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_project_or_404(db, user.id, project_id)
    return _project_to_response(row)


@router.put("/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: str,
    req: ProjectUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_project_or_404(db, user.id, project_id)
    patch = req.model_dump(exclude_unset=True)

    if "project_type_id" in patch and patch["project_type_id"] is not None:
        await _get_project_type_or_404(db, user.id, patch["project_type_id"])
    if "name" in patch and patch["name"] is not None:
        row.name = patch["name"].strip()
    if "project_type_id" in patch:
        row.project_type_id = patch["project_type_id"]
    if "context_doc" in patch and patch["context_doc"] is not None:
        row.context_doc = patch["context_doc"]
    row.updated_at = _now()

    await db.commit()
    await db.refresh(row)
    return _project_to_response(row)


@router.delete("/{project_id}")
async def delete_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_project_or_404(db, user.id, project_id)
    await db.delete(row)
    await db.commit()
    return {"ok": True}
